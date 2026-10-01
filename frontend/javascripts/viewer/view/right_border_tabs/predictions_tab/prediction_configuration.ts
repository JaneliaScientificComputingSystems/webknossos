/*
 * All state and logic for the "ID Prediction" feature — contact-profile
 * upload, reference-dataset selection, ignored names, running live
 * prediction, and offline-prediction upload — lives here, not in a view.
 * Exposed to the component tree via PredictionConfigurationContext
 * (prediction_configuration_context.tsx), called once near the root of the
 * neuron-identity panel, so PredictionsView's own controls and the
 * always-visible "Run prediction(s)" button (which lives outside that tab)
 * both read/mutate the same state via useContext instead of one owning a ref
 * into the other or each holding an unsynchronized copy.
 */
import { getMeshFileChunksForSegment } from "admin/api/mesh";
import { getSegmentCentersOfMass } from "admin/rest_api";
import { useWkSelector } from "libs/react_hooks";
import Toast from "libs/toast";
import { useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import type { Vector3 } from "viewer/constants";
import { mayEditAnnotation } from "viewer/model/accessors/annotation_accessor";
import { getMagInfo, getVisibleSegmentationLayer } from "viewer/model/accessors/dataset_accessor";
import {
  getCurrentMappingName,
  getVisibleSegments,
} from "viewer/model/accessors/volumetracing_accessor";
import {
  dispatchMaybeFetchMeshFilesAsync,
  setAnnotationDescriptionAction,
} from "viewer/model/actions/annotation_actions";
import {
  batchUpdateGroupsAndSegmentsAction,
  updateSegmentAction,
} from "viewer/model/actions/volumetracing_actions";
import { waitUntilRebaseFinished } from "viewer/model/helpers/bounding_box_creation_helpers";
import {
  getSegmentIdentity,
  withMergedCandidates,
} from "viewer/view/right_border_tabs/neuron_identity_tab/neuron_identity_metadata";
import {
  type ContactEdge,
  getDistinctNeuronIds,
} from "viewer/view/right_border_tabs/predictions_tab/contact_profile";
import {
  getReferenceDatasets,
  type PredictionServiceInputSegment,
  type PredictRequestPayload,
  type PredictResponsePayload,
  requestPredictions,
  type SegmentPredictionPayload,
} from "viewer/view/right_border_tabs/predictions_tab/prediction_client";
import {
  encodeConfigIntoDescription,
  parseConfigFromDescription,
} from "viewer/view/right_border_tabs/predictions_tab/prediction_config_persistence";
import {
  getBaseSegmentationName,
  hasSegmentIndex,
} from "viewer/view/right_border_tabs/segments_tab/segments_view_helper";

// Keyed by reference dataset, not a single shared constant, so predictions
// against different Witvliet stages are kept as parallel scores per name
// instead of the later run silently overwriting the earlier one's score.
function predictionSourceFor(referenceDataset: string): string {
  return `prediction:${referenceDataset}`;
}
// Position lookups (segment index / mesh file) still cost one request per
// new segment, so cap how many of THOSE happen per click — but this no
// longer limits how many predictions get written, since the write itself is
// a single batched dispatch regardless of count.
const MAX_POSITION_LOOKUPS_PER_CLICK = 25;

export type WriteResult = { written: number; createdCount: number; positionedCount: number };

export function usePredictionConfigurationState() {
  const dispatch = useDispatch();
  const dataset = useWkSelector((state) => state.dataset);
  const annotation = useWkSelector((state) => state.annotation);
  const additionalCoordinates = useWkSelector((state) => state.flycam.additionalCoordinates);
  const mappingName = useWkSelector(getCurrentMappingName);
  const visibleSegmentationLayer = useWkSelector(getVisibleSegmentationLayer);
  const segments = useWkSelector((state) => getVisibleSegments(state).segments);
  const allowUpdate = useWkSelector(
    (state) =>
      mayEditAnnotation(state) &&
      !(visibleSegmentationLayer != null && visibleSegmentationLayer.tracingId == null),
  );

  // Names excluded from the reference contactome used for live Run matching,
  // and from Search by Name's autocomplete suggestions elsewhere in the
  // neuron-identity panel. Persisted into annotation.description (see
  // prediction_config_persistence.ts) alongside the contact profile below, so
  // both survive a reload/new session instead of resetting every time.
  const [ignoredNames, setIgnoredNames] = useState<string[]>([]);

  const [selectedReferenceDatasets, setSelectedReferenceDatasets] = useState<Set<string>>(
    new Set(),
  );
  const [referenceDatasetsStatus, setReferenceDatasetsStatus] = useState<
    "loading" | "loaded" | "failed"
  >("loading");
  const [referenceDatasets, setReferenceDatasets] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  // Snapshot of which names were confirmed at the moment of the most recent
  // successful Run — null until the first Run completes. Lets consumers
  // (the Confirmed IDs box) diff "confirmed now" against "confirmed as of
  // last Run" to show how much has changed since predictions were last
  // generated, without this hook needing to know anything about rendering.
  const [lastRunConfirmedNames, setLastRunConfirmedNames] = useState<Set<string> | null>(null);

  // Populate the reference-dataset checkboxes from the service itself, rather
  // than hardcoding the list here — it's the service (not the frontend) that
  // knows which developmental stages it can actually match against.
  useEffect(() => {
    let cancelled = false;
    getReferenceDatasets().then(
      (datasets) => {
        if (cancelled) {
          return;
        }
        setReferenceDatasets(datasets);
        setReferenceDatasetsStatus("loaded");
        setSelectedReferenceDatasets((current) =>
          current.size > 0 ? current : new Set(datasets[0] != null ? [datasets[0]] : []),
        );
      },
      () => {
        if (!cancelled) {
          setReferenceDatasetsStatus("failed");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleReferenceDataset = (referenceDataset: string, checked: boolean) => {
    setSelectedReferenceDatasets((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(referenceDataset);
      } else {
        next.delete(referenceDataset);
      }
      return next;
    });
  };

  // Ensures this layer's mesh file (if any) is fetched and activated as a
  // side effect (precomputed_mesh_saga.ts) — populates `currentMeshFile`
  // below, which the mesh-file position fallback in fetchAnchorPositions
  // needs. hasSegmentIndex (the other position source) is checked directly
  // inside fetchAnchorPositions instead, at call time.
  const currentMeshFile = useWkSelector((state) =>
    visibleSegmentationLayer != null
      ? state.localSegmentationStateByLayer[visibleSegmentationLayer.name]?.currentMeshFile
      : null,
  );
  useEffect(() => {
    if (visibleSegmentationLayer == null) {
      return;
    }
    dispatchMaybeFetchMeshFilesAsync(dispatch, visibleSegmentationLayer, dataset, false);
  }, [visibleSegmentationLayer, dataset, dispatch]);

  // Best-effort position lookup for arbitrary segment IDs, using either of
  // this layer's two independent, optional position sources, cheapest first:
  // a segment index (bounding box per ID, batched, tried first since it's
  // cheap); or a mesh file (chunk positions, one HTTP call per ID, tried only
  // for IDs the above couldn't resolve). See MESH_POSITION_LOOKUP_PLAN.md.
  // Returns an empty map if no source resolves an ID — callers fall back to
  // leaving position unset. Note: segments already in the segment list get
  // backfilled independently (and for free) by segment_position_cache.ts as
  // soon as they're added, from buckets already loaded during this session —
  // this function only covers the remaining, harder case of a position for a
  // segment that cache has never seen.
  const fetchAnchorPositions = async (ids: bigint[]): Promise<Map<bigint, Vector3>> => {
    const positionByNeuronId = new Map<bigint, Vector3>();
    if (ids.length === 0 || visibleSegmentationLayer == null) {
      return positionByNeuronId;
    }
    let remainingIds: bigint[] = ids;
    const segmentIndexAvailable = await hasSegmentIndex(
      visibleSegmentationLayer,
      dataset,
      annotation,
    );
    if (segmentIndexAvailable) {
      const finestMag = getMagInfo(visibleSegmentationLayer.mags).getFinestMag();
      const layerSourceInfo = {
        dataset,
        annotation,
        tracingId: visibleSegmentationLayer.tracingId ?? undefined,
        segmentationLayerName: visibleSegmentationLayer.name,
      };
      // Voxel-weighted center of mass, not a bounding-box midpoint: for a
      // concave/ring-shaped segment (e.g. neurons wrapped around a lumen),
      // the geometric center of its bounding box can fall in empty space
      // that isn't part of the segment at all. Center of mass is far more
      // likely to land on real segment voxels, though still not a hard
      // guarantee for pathological shapes.
      const centersOfMass = await getSegmentCentersOfMass(
        layerSourceInfo,
        finestMag,
        remainingIds,
        additionalCoordinates,
        mappingName,
      );
      const stillMissing: bigint[] = [];
      remainingIds.forEach((neuronId, index) => {
        const centerOfMass = centersOfMass[index];
        if (centerOfMass == null) {
          stillMissing.push(neuronId);
          return;
        }
        positionByNeuronId.set(neuronId, [
          Math.round(centerOfMass[0] * finestMag[0]),
          Math.round(centerOfMass[1] * finestMag[1]),
          Math.round(centerOfMass[2] * finestMag[2]),
        ]);
      });
      remainingIds = stillMissing;
    }
    if (remainingIds.length > 0 && currentMeshFile != null) {
      // No batched endpoint exists for mesh chunks (unlike the bounding-box
      // lookup above) — one HTTP request per remaining ID. Callers already
      // cap the id list (MAX_POSITION_LOOKUPS_PER_CLICK) before calling this.
      for (const neuronId of remainingIds) {
        const position = await fetchAnchorPositionFromMeshFile(neuronId);
        if (position != null) {
          positionByNeuronId.set(neuronId, position);
        }
      }
    }
    return positionByNeuronId;
  };

  // Approximates a segment's position from its mesh file's chunk metadata,
  // without fetching or decoding any mesh geometry. Each listed chunk is the
  // origin corner of an octree cell that the meshing algorithm found actual
  // segment surface within (see NeuroglancerMeshHelper.scala) — i.e. it's a
  // real, guaranteed-on-segment point, unlike a bounding-box midpoint across
  // multiple chunks, which can land in empty space between two lobes of a
  // branching/non-convex segment. So: pick ONE real chunk position directly
  // rather than averaging several into a synthetic point. Takes the coarsest
  // LOD (highest index — index 0 is finest, increasing index is coarser, so
  // the last LOD has the fewest chunks and is cheapest to enumerate); which
  // specific chunk is picked doesn't matter for correctness, only for how
  // close to this segment's "middle" the jump lands.
  const fetchAnchorPositionFromMeshFile = async (neuronId: bigint): Promise<Vector3 | null> => {
    if (visibleSegmentationLayer == null || currentMeshFile == null) {
      return null;
    }
    try {
      const segmentInfo = await getMeshFileChunksForSegment(
        dataset.dataStore.url,
        dataset.id,
        getBaseSegmentationName(visibleSegmentationLayer),
        currentMeshFile,
        neuronId,
        currentMeshFile.mappingName == null ? mappingName : null,
        null,
        annotation.version,
      );
      const coarsestLod = segmentInfo.lods.at(-1);
      const chunk = coarsestLod?.chunks[Math.floor(coarsestLod.chunks.length / 2)];
      return chunk?.position ?? null;
    } catch (_exception) {
      return null;
    }
  };

  // Contact profile: a weighted contact graph between segments, dropped as a
  // CSV/TSV file. Persisted (as parsed edges, not the raw file text) into
  // annotation.description — see prediction_config_persistence.ts for why
  // that field and how it coexists with the human-written description.
  const [contactEdges, setContactEdges] = useState<ContactEdge[]>([]);
  const [contactFileName, setContactFileName] = useState<string | null>(null);
  const [contactUploadedAt, setContactUploadedAt] = useState<number | null>(null);

  // Guards the save effect below from firing on the very first render (before
  // the one-time load effect has had a chance to populate state from
  // annotation.description) — without this, mount would immediately "save"
  // the still-empty initial state right over whatever was persisted.
  const hasLoadedPersistedConfig = useRef(false);
  useEffect(() => {
    const persisted = parseConfigFromDescription(annotation.description);
    if (persisted != null) {
      setContactEdges(persisted.contactEdges);
      setContactFileName(persisted.contactFileName);
      setContactUploadedAt(persisted.contactUploadedAt);
      setIgnoredNames(persisted.ignoredNames);
      setLastRunConfirmedNames(
        persisted.lastRunConfirmedNames != null ? new Set(persisted.lastRunConfirmedNames) : null,
      );
    }
    hasLoadedPersistedConfig.current = true;
    // Intentionally run once on mount only (new annotation.description
    // values written by THIS hook's own save effect below must not re-trigger
    // a reload, or every save would immediately read itself back).
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, []);

  useEffect(() => {
    if (!hasLoadedPersistedConfig.current) {
      return;
    }
    const nextDescription = encodeConfigIntoDescription(annotation.description, {
      contactEdges,
      contactFileName,
      contactUploadedAt,
      ignoredNames,
      lastRunConfirmedNames:
        lastRunConfirmedNames != null ? Array.from(lastRunConfirmedNames) : null,
    });
    if (nextDescription !== annotation.description) {
      dispatch(setAnnotationDescriptionAction(nextDescription));
    }
    // annotation.description is deliberately excluded from the dependency
    // list: it's both read and written here, and including it would re-run
    // this effect (and compare against its own just-written value) on every
    // description change from ANYWHERE, not just from this hook's own state.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, [
    contactEdges,
    contactFileName,
    contactUploadedAt,
    ignoredNames,
    lastRunConfirmedNames,
    dispatch,
  ]);

  const setContactProfile = (edges: ContactEdge[], fileName: string) => {
    setContactEdges(edges);
    setContactFileName(fileName);
    setContactUploadedAt(Date.now());
  };

  const clearContactProfile = () => {
    setContactEdges([]);
    setContactFileName(null);
    setContactUploadedAt(null);
  };

  // Shared by Run (live prediction) and offline-predictions upload: both
  // produce a batch of (segment, candidates) writes that must land in a
  // SINGLE dispatch. Dispatching one updateSegmentAction per neuron in a
  // plain loop runs the reducer + diffing saga + a re-render once per
  // neuron, synchronously, which froze the tab for large contact profiles —
  // batchActions collapses that into one reducer pass and one re-render
  // regardless of how many segments are touched.
  const writeMergedCandidates = async (
    source: string,
    predictions: SegmentPredictionPayload[],
  ): Promise<WriteResult> => {
    if (visibleSegmentationLayer == null || segments == null) {
      return { written: 0, createdCount: 0, positionedCount: 0 };
    }
    const newSegmentIds = predictions
      .map((prediction) => BigInt(prediction.segment_id))
      .filter((segmentId) => segments.getNullable(segmentId) == null);

    // Position lookups cost one request per new segment (mesh-file fallback
    // has no batched endpoint), so still cap how many of those run per
    // click — segments beyond the cap are still created and get their
    // candidates written, just without a known position yet. "Fill in
    // missing positions" can pick up the rest afterward.
    const positionLookupIds = newSegmentIds.slice(0, MAX_POSITION_LOOKUPS_PER_CLICK);
    let positionByNeuronId = new Map<bigint, Vector3>();
    try {
      positionByNeuronId = await fetchAnchorPositions(positionLookupIds);
    } catch (_exception) {
      // Fall through — segments are created without a position below.
    }

    const predictedAt = Date.now();
    let createdCount = 0;
    let positionedCount = 0;
    const actions = predictions.map((prediction) => {
      const segmentId = BigInt(prediction.segment_id);
      const segment = segments.getNullable(segmentId);
      const anchorPosition = positionByNeuronId.get(segmentId);
      if (segment == null) {
        createdCount += 1;
        if (anchorPosition != null) {
          positionedCount += 1;
        }
      }
      return updateSegmentAction(
        segmentId,
        {
          ...(anchorPosition != null ? { anchorPosition } : {}),
          metadata: withMergedCandidates(
            segment?.metadata ?? [],
            source,
            prediction.candidates,
            predictedAt,
          ),
        },
        visibleSegmentationLayer.name,
        undefined,
        true,
      );
    });

    if (actions.length > 0) {
      // See generate_bounding_boxes_modal.tsx for the same pattern: wait out
      // any active rebase so the batch isn't dropped by the rebase edit
      // guard, then dispatch synchronously. Must use
      // batchUpdateGroupsAndSegmentsAction (not a raw batchActions call with
      // an invented label) — the save-queue-filling saga only wakes up for
      // action TYPES listed in VolumeTracingSaveRelevantActions, and a novel
      // batch label isn't one of them, so the write would silently never
      // reach the save queue/backend and be lost on reload.
      await waitUntilRebaseFinished();
      dispatch(batchUpdateGroupsAndSegmentsAction(actions));
    }
    return { written: actions.length, createdCount, positionedCount };
  };

  const canRun =
    allowUpdate && contactEdges.length > 0 && selectedReferenceDatasets.size > 0 && !isRunning;

  const run = async () => {
    if (visibleSegmentationLayer == null || segments == null) {
      return;
    }
    if (contactEdges.length === 0 || selectedReferenceDatasets.size === 0) {
      return;
    }
    setIsRunning(true);
    try {
      // Snapshot every currently-confirmed name across ALL segments (not just
      // this run's targets) — this is the baseline the Confirmed IDs box
      // diffs against afterward to show what's changed since this Run.
      const confirmedNamesAtRunStart = new Set<string>();
      for (const segment of segments.values()) {
        const confirmed = getSegmentIdentity(segment).confirmed;
        if (confirmed != null) {
          confirmedNamesAtRunStart.add(confirmed);
        }
      }
      setLastRunConfirmedNames(confirmedNamesAtRunStart);

      // The contact profile's neurons are the prediction targets, regardless
      // of whether they're already in the local segment list — a fresh
      // contact profile commonly references neurons the user hasn't clicked
      // on yet. Build each entry from the live segment if one already
      // exists (so its real name/confirmed status reaches the service),
      // falling back to a minimal placeholder otherwise. Read fresh at click
      // time so segments added after the file was loaded (e.g. via
      // proofreading in between Run clicks) are picked up too.
      // Segments marked "ignore (not a neuron)" are dropped entirely —
      // from both the targets AND any contact edge that references them —
      // so they're never sent to the matcher at all.
      const ignoredIds = new Set(
        Array.from(segments.values())
          .filter((segment) => getSegmentIdentity(segment).ignored)
          .map((segment) => Number(segment.id)),
      );
      const targetIds = getDistinctNeuronIds(contactEdges).filter((id) => !ignoredIds.has(id));
      const requestSegments: PredictionServiceInputSegment[] = targetIds.map((neuronId) => {
        const segment = segments.getNullable(BigInt(neuronId));
        if (segment == null) {
          return { id: neuronId, name: null, is_confirmed: false };
        }
        return {
          id: Number(segment.id),
          name: segment.name ?? null,
          is_confirmed: getSegmentIdentity(segment).confirmed != null,
        };
      });
      const requestContactEdges = contactEdges
        .filter((edge) => !ignoredIds.has(edge.neuronA) && !ignoredIds.has(edge.neuronB))
        .map((edge) => ({
          neuron_a: edge.neuronA,
          neuron_b: edge.neuronB,
          weight: edge.weight,
        }));

      // One request + one write per checked reference dataset, run in
      // sequence rather than in parallel — these all write to the same
      // segments' metadata, and writeMergedCandidates reads each segment's
      // CURRENT metadata before merging in its own source's entry, so
      // running them concurrently could let one run's read miss another's
      // not-yet-dispatched write.
      let totalWritten = 0;
      let totalCreated = 0;
      let totalPositioned = 0;
      const failedDatasets: string[] = [];
      for (const referenceDataset of selectedReferenceDatasets) {
        const payload: PredictRequestPayload = {
          segments: requestSegments,
          contact_edges: requestContactEdges,
          reference_dataset: referenceDataset,
          ignored_names: ignoredNames,
        };

        let response: PredictResponsePayload;
        try {
          response = await requestPredictions(payload);
        } catch (exception) {
          failedDatasets.push(referenceDataset);
          Toast.error(
            `${referenceDataset}: ${
              exception instanceof Error
                ? exception.message
                : "Could not reach the prediction service."
            }`,
          );
          continue;
        }

        const { written, createdCount, positionedCount } = await writeMergedCandidates(
          predictionSourceFor(referenceDataset),
          response.predictions,
        );
        totalWritten += written;
        totalCreated += createdCount;
        totalPositioned += positionedCount;
      }

      if (totalWritten > 0) {
        Toast.success(
          totalCreated > 0
            ? `Wrote predictions to ${totalWritten} segment(s) across ${selectedReferenceDatasets.size - failedDatasets.length} dataset(s) (${totalCreated} newly added to the segment list, ${totalPositioned} with a known position). Proofread them in the Identities tab.`
            : `Wrote predictions to ${totalWritten} segment(s) across ${selectedReferenceDatasets.size - failedDatasets.length} dataset(s). Proofread them in the Identities tab.`,
        );
      }
    } finally {
      setIsRunning(false);
    }
  };

  return {
    allowUpdate,
    datasetId: dataset.id,
    ignoredNames,
    setIgnoredNames,
    contactEdges,
    contactFileName,
    contactUploadedAt,
    setContactProfile,
    clearContactProfile,
    referenceDatasets,
    referenceDatasetsStatus,
    selectedReferenceDatasets,
    toggleReferenceDataset,
    isRunning,
    canRun,
    run,
    writeMergedCandidates,
    lastRunConfirmedNames,
  };
}

export type PredictionConfigurationState = ReturnType<typeof usePredictionConfigurationState>;
