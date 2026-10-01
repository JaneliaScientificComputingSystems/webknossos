import { DeleteOutlined, ThunderboltOutlined, UploadOutlined } from "@ant-design/icons";
import { getMeshFileChunksForSegment } from "admin/api/mesh";
import { getSegmentCentersOfMass } from "admin/rest_api";
import { Button, Divider, Empty, Input, Select, Tag, Tooltip, Typography, Upload } from "antd";
import type { UploadChangeParam, UploadFile } from "antd/lib/upload";
import { useWkSelector } from "libs/react_hooks";
import { readFileAsText } from "libs/read_file";
import Toast from "libs/toast";
import { type ReactNode, useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import type { Vector3 } from "viewer/constants";
import { mayEditAnnotation } from "viewer/model/accessors/annotation_accessor";
import { getMagInfo, getVisibleSegmentationLayer } from "viewer/model/accessors/dataset_accessor";
import {
  getCurrentMappingName,
  getVisibleSegments,
} from "viewer/model/accessors/volumetracing_accessor";
import { dispatchMaybeFetchMeshFilesAsync } from "viewer/model/actions/annotation_actions";
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
  countDistinctNeurons,
  getDistinctNeuronIds,
  parseContactProfile,
} from "viewer/view/right_border_tabs/predictions_tab/contact_profile";
import {
  getReferenceDatasets,
  type PredictionServiceInputSegment,
  type PredictRequestPayload,
  type PredictResponsePayload,
  requestPredictions,
  type SegmentPredictionPayload,
  uploadOfflinePredictions,
} from "viewer/view/right_border_tabs/predictions_tab/prediction_client";
import {
  getBaseSegmentationName,
  hasSegmentIndex,
} from "viewer/view/right_border_tabs/segments_tab/segments_view_helper";

const { Text } = Typography;

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

/** One labeled parameter row. */
function ParamRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
      <Tooltip title={help}>
        <Text style={{ flex: 1 }}>{label}</Text>
      </Tooltip>
      <div>{children}</div>
    </div>
  );
}

export default function PredictionsView({
  ignoredNames,
  onIgnoredNamesChange,
}: {
  /** Names excluded from the reference contactome for live Run matching, and from autocomplete elsewhere. */
  ignoredNames: string[];
  onIgnoredNamesChange: (ignoredNames: string[]) => void;
}) {
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

  // Prediction parameters. These mirror the (future) prediction-service request;
  // add real algorithm parameters here as they are defined.
  const [referenceDataset, setReferenceDataset] = useState<string | null>(null);
  const [referenceDatasetsStatus, setReferenceDatasetsStatus] = useState<
    "loading" | "loaded" | "failed"
  >("loading");
  const [referenceDatasets, setReferenceDatasets] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [newIgnoredName, setNewIgnoredName] = useState("");

  // Populate the reference-dataset dropdown from the service itself, rather
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
        setReferenceDataset((current) => current ?? datasets[0] ?? null);
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
    const segmentIndexAvailable = await hasSegmentIndex(visibleSegmentationLayer, dataset, annotation);
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
  // CSV/TSV file. In-memory only (not persisted); a future feature input to the
  // predictor, not yet consumed by the mock predictor. See plan §9.
  const [contactEdges, setContactEdges] = useState<ContactEdge[]>([]);
  const [contactFileName, setContactFileName] = useState<string | null>(null);


  const handleContactFileChange = async (info: UploadChangeParam<UploadFile<any>>) => {
    const file = info.fileList[info.fileList.length - 1]?.originFileObj;
    if (file == null || visibleSegmentationLayer == null) {
      return;
    }
    try {
      const contents = await readFileAsText(file);
      const { edges, skippedRowCount } = parseContactProfile(contents);
      if (edges.length === 0) {
        Toast.error("No valid contact rows found in this file.");
        return;
      }
      setContactEdges(edges);
      setContactFileName(file.name);
      if (skippedRowCount > 0) {
        Toast.info(`Skipped ${skippedRowCount} row(s) that didn't fit the expected format.`);
      }
    } catch (exception) {
      Toast.error(
        exception instanceof Error ? exception.message : "Could not read the contact profile file.",
      );
    }
  };

  const handleClearContacts = () => {
    setContactEdges([]);
    setContactFileName(null);
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
  ) => {
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

  const handleRun = async () => {
    if (visibleSegmentationLayer == null || segments == null) {
      return;
    }
    if (contactEdges.length === 0 || referenceDataset == null) {
      return;
    }
    setIsRunning(true);
    try {
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

      const payload: PredictRequestPayload = {
        segments: requestSegments,
        contact_edges: contactEdges
          .filter((edge) => !ignoredIds.has(edge.neuronA) && !ignoredIds.has(edge.neuronB))
          .map((edge) => ({
            neuron_a: edge.neuronA,
            neuron_b: edge.neuronB,
            weight: edge.weight,
          })),
        reference_dataset: referenceDataset,
        ignored_names: ignoredNames,
      };

      let response: PredictResponsePayload;
      try {
        response = await requestPredictions(payload);
      } catch (exception) {
        Toast.error(
          exception instanceof Error
            ? exception.message
            : "Could not reach the prediction service.",
        );
        return;
      }

      const { written, createdCount, positionedCount } = await writeMergedCandidates(
        predictionSourceFor(referenceDataset),
        response.predictions,
      );
      Toast.success(
        createdCount > 0
          ? `Wrote predictions to ${written} segment(s) (${createdCount} newly added to the segment list, ${positionedCount} with a known position). Proofread them in the Identities tab.`
          : `Wrote predictions to ${written} segment(s). Proofread them in the Identities tab.`,
      );
    } finally {
      setIsRunning(false);
    }
  };

  const [isUploadingOfflinePredictions, setIsUploadingOfflinePredictions] = useState(false);

  const handleOfflinePredictionsUpload = async (info: UploadChangeParam<UploadFile<any>>) => {
    const file = info.fileList[info.fileList.length - 1]?.originFileObj;
    if (file == null || visibleSegmentationLayer == null) {
      return;
    }
    setIsUploadingOfflinePredictions(true);
    try {
      const response = await uploadOfflinePredictions(dataset.id, file);
      // Use the filename without its extension as the solution/source name
      // (e.g. "morphology_scores.csv" -> "morphology_scores") — shorter and
      // more readable than the full filename wherever the source shows up
      // (candidate tooltips, the per-source row label, raw metadata keys).
      const sourceName = file.name.replace(/\.[^./]+$/, "");
      const { written, createdCount, positionedCount } = await writeMergedCandidates(
        sourceName,
        response.predictions,
      );
      Toast.success(
        createdCount > 0
          ? `Wrote offline predictions to ${written} segment(s) (${createdCount} newly added to the segment list, ${positionedCount} with a known position).`
          : `Wrote offline predictions to ${written} segment(s).`,
      );
    } catch (exception) {
      Toast.error(
        exception instanceof Error ? exception.message : "Could not upload offline predictions.",
      );
    } finally {
      setIsUploadingOfflinePredictions(false);
    }
  };

  if (visibleSegmentationLayer == null) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No visible segmentation layer."
        style={{ marginTop: 40 }}
      />
    );
  }

  return (
    <div style={{ padding: 12, height: "100%", overflowY: "auto" }}>
      <Text strong style={{ display: "block", marginBottom: 4 }}>
        Contact profile
      </Text>
      <Text style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
        Upload a CSV/TSV file of segment contacts to use for ID prediction. Must have a header row
        with "neuron1", "neuron2" (segment IDs), and "contact_strength" columns.
      </Text>
      <Upload
        name="contactProfile"
        accept=".csv,.tsv,text/csv,text/tab-separated-values"
        showUploadList={false}
        beforeUpload={() => false}
        onChange={handleContactFileChange}
        maxCount={1}
      >
        <Button icon={<UploadOutlined />}>Upload new contact profile</Button>
      </Upload>
      {contactFileName != null && (
        <>
          <div
            style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}
          >
            <Text style={{ flex: 1 }} ellipsis>
              {contactFileName}
            </Text>
            <Tooltip title="Clear contact profile">
              <Button size="small" icon={<DeleteOutlined />} onClick={handleClearContacts} />
            </Tooltip>
          </div>
          <Text style={{ display: "block", fontSize: 12 }}>
            {contactEdges.length} contact(s) across {countDistinctNeurons(contactEdges)} neuron(s)
          </Text>
        </>
      )}

      <Divider style={{ margin: "12px 0" }} />

      <ParamRow
        label="Reference dataset"
        help="Developmental-stage contactome to match against, fetched from the prediction service."
      >
        <Select<string>
          size="small"
          value={referenceDataset ?? undefined}
          onChange={setReferenceDataset}
          style={{ width: 180 }}
          loading={referenceDatasetsStatus === "loading"}
          placeholder={
            referenceDatasetsStatus === "failed" ? "Could not load datasets" : "Select a dataset"
          }
          disabled={referenceDatasetsStatus !== "loaded"}
          options={referenceDatasets.map((dataset) => ({ value: dataset, label: dataset }))}
        />
      </ParamRow>

      <Text strong style={{ display: "block", marginBottom: 4 }}>
        Ignored names
      </Text>
      <Text type="secondary" style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
        Excluded from the reference dataset for live Run matching, and from autocomplete
        suggestions elsewhere.
      </Text>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <Input
          size="small"
          value={newIgnoredName}
          onChange={(event) => setNewIgnoredName(event.currentTarget.value)}
          onPressEnter={() => {
            const trimmed = newIgnoredName.trim();
            if (trimmed.length > 0 && !ignoredNames.includes(trimmed)) {
              onIgnoredNamesChange([...ignoredNames, trimmed]);
            }
            setNewIgnoredName("");
          }}
          placeholder="Neuron name…"
          style={{ flex: 1 }}
        />
        <Button
          size="small"
          onClick={() => {
            const trimmed = newIgnoredName.trim();
            if (trimmed.length > 0 && !ignoredNames.includes(trimmed)) {
              onIgnoredNamesChange([...ignoredNames, trimmed]);
            }
            setNewIgnoredName("");
          }}
        >
          Add
        </Button>
      </div>
      {ignoredNames.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
          {ignoredNames.map((name) => (
            <Tag
              key={name}
              closable
              onClose={() => onIgnoredNamesChange(ignoredNames.filter((n) => n !== name))}
            >
              {name}
            </Tag>
          ))}
        </div>
      )}

      <Divider style={{ margin: "12px 0" }} />

      <Tooltip
        title={
          !allowUpdate
            ? "Open an editable annotation to run prediction."
            : contactEdges.length === 0
              ? "Upload a contact profile first."
              : referenceDataset == null
                ? "Select a reference dataset first."
                : undefined
        }
      >
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          disabled={!allowUpdate || contactEdges.length === 0 || referenceDataset == null}
          loading={isRunning}
          onClick={handleRun}
          block
        >
          Run prediction
        </Button>
      </Tooltip>

      <Divider style={{ margin: "12px 0" }} />

      <Text strong style={{ display: "block", marginBottom: 4 }}>
        Upload Offline Predictions
      </Text>
      <Text style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
        Upload a CSV with header
        rows "seg" (segment ID), "neuron" (a neuron name), and
        "score" columns. Filename will be used as prediction name. Ideally scores are in confidence percentage space to they can be averaged with other confidence scores.
      </Text>
      <Upload
        name="offlinePredictions"
        accept=".csv,.tsv,text/csv,text/tab-separated-values"
        showUploadList={false}
        beforeUpload={() => false}
        onChange={handleOfflinePredictionsUpload}
        maxCount={1}
        disabled={!allowUpdate || isUploadingOfflinePredictions}
      >
        <Button icon={<UploadOutlined />} loading={isUploadingOfflinePredictions}>
          Upload offline predictions CSV…
        </Button>
      </Upload>
    </div>
  );
}
