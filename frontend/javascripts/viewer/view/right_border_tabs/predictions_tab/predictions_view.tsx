import { DeleteOutlined, ThunderboltOutlined, UploadOutlined } from "@ant-design/icons";
import { getMeshFileChunksForSegment } from "admin/api/mesh";
import { getSegmentBoundingBoxes } from "admin/rest_api";
import { Button, Divider, Empty, InputNumber, Select, Tooltip, Typography, Upload } from "antd";
import type { UploadChangeParam, UploadFile } from "antd/lib/upload";
import { useWkSelector } from "libs/react_hooks";
import { readFileAsText } from "libs/read_file";
import Toast from "libs/toast";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useDispatch } from "react-redux";
import { batchActions } from "redux-batched-actions";
import type { Vector3 } from "viewer/constants";
import { mayEditAnnotation } from "viewer/model/accessors/annotation_accessor";
import { getMagInfo, getVisibleSegmentationLayer } from "viewer/model/accessors/dataset_accessor";
import {
  getCurrentMappingName,
  getVisibleSegments,
} from "viewer/model/accessors/volumetracing_accessor";
import type { Action } from "viewer/model/actions/actions";
import { dispatchMaybeFetchMeshFilesAsync } from "viewer/model/actions/annotation_actions";
import { updateSegmentAction } from "viewer/model/actions/volumetracing_actions";
import { waitUntilRebaseFinished } from "viewer/model/helpers/bounding_box_creation_helpers";
import { getBoundingBoxInMag1 } from "viewer/model/sagas/volume/helpers";
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

const { Text, Title } = Typography;

const PREDICTION_SOURCE = "prediction";
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

export default function PredictionsView() {
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
  const [maxCandidates, setMaxCandidates] = useState(5);
  const [isRunning, setIsRunning] = useState(false);
  const [isBackfilling, setIsBackfilling] = useState(false);

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

  // Whether this layer has a precomputed segment index at all — without one,
  // there is no way to look up a position for a segment ID the user hasn't
  // clicked on, and every "position unknown" symptom below is expected, not a
  // bug. Checked once per layer so the UI can say so up front instead of only
  // surfacing it after a Run.
  const [segmentIndexStatus, setSegmentIndexStatus] = useState<
    "checking" | "available" | "unavailable"
  >("checking");
  useEffect(() => {
    if (visibleSegmentationLayer == null) {
      setSegmentIndexStatus("unavailable");
      return;
    }
    let cancelled = false;
    setSegmentIndexStatus("checking");
    hasSegmentIndex(visibleSegmentationLayer, dataset, annotation).then(
      (available) => {
        if (!cancelled) {
          setSegmentIndexStatus(available ? "available" : "unavailable");
        }
      },
      () => {
        if (!cancelled) {
          setSegmentIndexStatus("unavailable");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visibleSegmentationLayer, dataset, annotation]);

  // Whether this layer has a precomputed mesh file at all — the second,
  // independent position source (see MESH_POSITION_LOOKUP_PLAN.md). Reuses
  // the same fetch+auto-activate mechanism the Segments panel and 3D viewport
  // use (precomputed_mesh_saga.ts), so `currentMeshFile` below ends up
  // populated in Redux as a side effect, not just this status flag.
  const [meshFileStatus, setMeshFileStatus] = useState<"checking" | "available" | "unavailable">(
    "checking",
  );
  const currentMeshFile = useWkSelector((state) =>
    visibleSegmentationLayer != null
      ? state.localSegmentationStateByLayer[visibleSegmentationLayer.name]?.currentMeshFile
      : null,
  );
  useEffect(() => {
    if (visibleSegmentationLayer == null) {
      setMeshFileStatus("unavailable");
      return;
    }
    let cancelled = false;
    setMeshFileStatus("checking");
    dispatchMaybeFetchMeshFilesAsync(dispatch, visibleSegmentationLayer, dataset, false).then(
      (availableMeshFiles) => {
        if (!cancelled) {
          setMeshFileStatus(availableMeshFiles.length > 0 ? "available" : "unavailable");
        }
      },
      () => {
        if (!cancelled) {
          setMeshFileStatus("unavailable");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visibleSegmentationLayer, dataset, dispatch]);

  // Best-effort position lookup for arbitrary segment IDs, using either of
  // this layer's two independent, optional precomputed sources — a segment
  // index (bounding box per ID, batched, tried first since it's cheap) or a
  // mesh file (chunk positions, one HTTP call per ID, tried only for IDs the
  // segment index couldn't resolve). See MESH_POSITION_LOOKUP_PLAN.md. Returns
  // an empty map if neither source exists, both fail, or an ID is unknown to
  // both — callers fall back to leaving position unset.
  const fetchAnchorPositions = async (ids: bigint[]): Promise<Map<bigint, Vector3>> => {
    const positionByNeuronId = new Map<bigint, Vector3>();
    if (ids.length === 0 || visibleSegmentationLayer == null) {
      return positionByNeuronId;
    }
    let remainingIds = ids;
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
      const boundingBoxes = await getSegmentBoundingBoxes(
        layerSourceInfo,
        finestMag,
        ids,
        additionalCoordinates,
        mappingName,
        annotation.version,
      );
      const stillMissing: bigint[] = [];
      ids.forEach((neuronId, index) => {
        const boundingBox = boundingBoxes[index];
        if (boundingBox == null) {
          stillMissing.push(neuronId);
          return;
        }
        const boundingBoxInMag1 = getBoundingBoxInMag1(boundingBox, finestMag);
        positionByNeuronId.set(neuronId, [
          Math.round(boundingBoxInMag1.topLeft[0] + boundingBoxInMag1.width / 2),
          Math.round(boundingBoxInMag1.topLeft[1] + boundingBoxInMag1.height / 2),
          Math.round(boundingBoxInMag1.topLeft[2] + boundingBoxInMag1.depth / 2),
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
  // without fetching or decoding any mesh geometry. There's no single
  // centroid/bbox field in the response, so this takes the coarsest LOD
  // (highest index — see NeuroglancerMeshHelper.scala, index 0 is finest and
  // increasing index is coarser, so the last LOD has the fewest chunks and is
  // cheapest to enumerate) and centers a bounding box over its chunk
  // positions. Approximate by construction — fine for "jump to", not for
  // anything precision-sensitive.
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
      if (coarsestLod == null || coarsestLod.chunks.length === 0) {
        return null;
      }
      const positions = coarsestLod.chunks.map((chunk) => chunk.position);
      const min: Vector3 = [...positions[0]];
      const max: Vector3 = [...positions[0]];
      for (const position of positions) {
        for (let axis = 0; axis < 3; axis++) {
          if (position[axis] < min[axis]) min[axis] = position[axis];
          if (position[axis] > max[axis]) max[axis] = position[axis];
        }
      }
      return [
        Math.round((min[0] + max[0]) / 2),
        Math.round((min[1] + max[1]) / 2),
        Math.round((min[2] + max[2]) / 2),
      ];
    } catch (_exception) {
      return null;
    }
  };

  // Contact profile: a weighted contact graph between segments, dropped as a
  // CSV/TSV file. In-memory only (not persisted); a future feature input to the
  // predictor, not yet consumed by the mock predictor. See plan §9.
  const [contactEdges, setContactEdges] = useState<ContactEdge[]>([]);
  const [contactFileName, setContactFileName] = useState<string | null>(null);

  // How many of the contact profile's neuron IDs are already in the segment
  // list (vs. ones Run prediction will add). The segment list only contains
  // segments the user has already interacted with, so a fresh contact profile
  // commonly references neurons that aren't in it yet — that's expected, not
  // an error.
  const matchedNeuronCount = useMemo(() => {
    if (segments == null) {
      return 0;
    }
    return getDistinctNeuronIds(contactEdges).filter(
      (id) => segments.getNullable(BigInt(id)) != null,
    ).length;
  }, [contactEdges, segments]);

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
      const neuronIds = getDistinctNeuronIds(edges);
      const matchedCount =
        segments == null
          ? 0
          : neuronIds.filter((id) => segments.getNullable(BigInt(id)) != null).length;
      Toast.success(
        skippedRowCount > 0
          ? `Loaded ${edges.length} contact(s) across ${neuronIds.length} neuron(s) (${skippedRowCount} row(s) skipped).`
          : `Loaded ${edges.length} contact(s) across ${neuronIds.length} neuron(s).`,
      );
      if (matchedCount < neuronIds.length) {
        Toast.info(
          `${matchedCount}/${neuronIds.length} are already in the segment list; the rest will be added when you run prediction.`,
        );
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
      // guard, then dispatch synchronously.
      await waitUntilRebaseFinished();
      dispatch(batchActions(actions, "UPDATE_PREDICTED_CANDIDATES") as unknown as Action);
    }
    return { written: actions.length, createdCount, positionedCount };
  };

  const handleRun = async () => {
    if (visibleSegmentationLayer == null || segments == null) {
      return;
    }
    if (contactEdges.length === 0) {
      Toast.warning("Load a contact profile file first — its neurons are the prediction targets.");
      return;
    }
    if (referenceDataset == null) {
      Toast.warning("Select a reference dataset first.");
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
      const targetIds = getDistinctNeuronIds(contactEdges);
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
        contact_edges: contactEdges.map((edge) => ({
          neuron_a: edge.neuronA,
          neuron_b: edge.neuronB,
          weight: edge.weight,
        })),
        max_candidates: maxCandidates,
        reference_dataset: referenceDataset,
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
        PREDICTION_SOURCE,
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
      const { written, createdCount, positionedCount } = await writeMergedCandidates(
        file.name,
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

  // Segments created by an earlier Run (before position lookup was added, or
  // while this layer had neither a segment index nor a mesh file yet) are
  // stuck at "position unknown" forever — Run skips them once they have any
  // status other than "none", so it never retries the lookup for them. This
  // action targets exactly that: existing contact-profile segments missing a
  // position, independent of prediction status.
  const handleBackfillPositions = async () => {
    if (visibleSegmentationLayer == null || segments == null) {
      return;
    }
    const idsMissingPosition = getDistinctNeuronIds(contactEdges)
      .map((id) => BigInt(id))
      .filter((id) => {
        const segment = segments.getNullable(id);
        return segment != null && segment.anchorPosition == null;
      });
    if (idsMissingPosition.length === 0) {
      Toast.info("Every contact-profile segment already has a known position.");
      return;
    }
    const capped = idsMissingPosition.length > MAX_POSITION_LOOKUPS_PER_CLICK;
    const idsToFix = idsMissingPosition.slice(0, MAX_POSITION_LOOKUPS_PER_CLICK);
    setIsBackfilling(true);
    try {
      const positionByNeuronId = await fetchAnchorPositions(idsToFix);
      if (positionByNeuronId.size === 0) {
        Toast.warning(
          "Could not find a position for any of these segments — this layer may have no precomputed segment index or mesh file, or these IDs aren't in either of them.",
        );
        return;
      }
      const actions = Array.from(positionByNeuronId).map(([neuronId, anchorPosition]) =>
        updateSegmentAction(
          neuronId,
          { anchorPosition },
          visibleSegmentationLayer.name,
          undefined,
          false,
        ),
      );
      await waitUntilRebaseFinished();
      dispatch(batchActions(actions, "BACKFILL_SEGMENT_POSITIONS") as unknown as Action);
      Toast.success(
        `Found a position for ${positionByNeuronId.size}/${idsToFix.length} segment(s).`,
      );
      if (capped) {
        Toast.info(
          `Capped at ${MAX_POSITION_LOOKUPS_PER_CLICK} per click (${idsMissingPosition.length} segment(s) missing a position). Click again to continue with the rest.`,
        );
      }
    } catch (_exception) {
      Toast.error("Could not look up segment positions.");
    } finally {
      setIsBackfilling(false);
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
      <Title level={5} style={{ marginTop: 0 }}>
        Predictions
      </Title>
      <Text type="secondary">
        Configure and run neuron-identity prediction. The neurons referenced in the loaded contact
        profile are the prediction targets; confirmed identities among them are used as seeds for
        the matcher and are left untouched. Results can be proof-read in the Proofreading tab.
      </Text>

      <Divider style={{ margin: "12px 0" }} />

      <Text strong style={{ display: "block", marginBottom: 4 }}>
        Contact profile
      </Text>
      <Text type="secondary" style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
        Optional: drop a CSV/TSV file of segment contacts to use as a future input feature for the
        predictor. Must have a header row with "neuron1" and "neuron2" columns (segment IDs); any
        other column is read as the contact strength.
      </Text>
      <Upload
        name="contactProfile"
        accept=".csv,.tsv,text/csv,text/tab-separated-values"
        showUploadList={false}
        beforeUpload={() => false}
        onChange={handleContactFileChange}
        maxCount={1}
      >
        <Button icon={<UploadOutlined />}>Select contact profile file…</Button>
      </Upload>
      {contactFileName != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <Text style={{ flex: 1 }} ellipsis>
            {contactFileName}: {contactEdges.length} contact(s) across{" "}
            {countDistinctNeurons(contactEdges)} neuron(s)
          </Text>
          <Tooltip title="Clear contact profile">
            <Button size="small" icon={<DeleteOutlined />} onClick={handleClearContacts} />
          </Tooltip>
        </div>
      )}
      {contactFileName != null && (
        <Text type="secondary" style={{ display: "block", marginTop: 4, fontSize: 12 }}>
          {matchedNeuronCount}/{countDistinctNeurons(contactEdges)} neuron ID(s) already in the
          segment list; the rest will be added when you run prediction.
        </Text>
      )}
      <Text
        type={
          segmentIndexStatus === "unavailable" && meshFileStatus === "unavailable"
            ? "warning"
            : "secondary"
        }
        style={{ display: "block", marginTop: 4, fontSize: 12 }}
      >
        Position source for this layer:{" "}
        {segmentIndexStatus === "checking" || meshFileStatus === "checking"
          ? "checking…"
          : segmentIndexStatus === "available" && meshFileStatus === "available"
            ? "segment index + mesh file available — new segments can get a real position"
            : segmentIndexStatus === "available"
              ? "segment index available — new segments can get a real position"
              : meshFileStatus === "available"
                ? "mesh file available — new segments can get a real (approximate) position"
                : "no segment index or mesh file — new segments will have no known position ('Go to segment' won't work for them). Generate a mesh file for this dataset to enable jump-to for predicted neurons."}
      </Text>
      {contactFileName != null && (
        <Tooltip
          title={
            allowUpdate
              ? "Look up a real position for contact-profile segments that are missing one (e.g. from an earlier run before this lookup existed)."
              : "Open an editable annotation to fill in positions."
          }
        >
          <Button
            size="small"
            style={{ marginTop: 8 }}
            disabled={
              !allowUpdate || (segmentIndexStatus !== "available" && meshFileStatus !== "available")
            }
            loading={isBackfilling}
            onClick={handleBackfillPositions}
          >
            Fill in missing positions
          </Button>
        </Tooltip>
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

      <ParamRow
        label="Max candidates / segment"
        help="Maximum number of ranked identities returned per segment."
      >
        <InputNumber
          size="small"
          min={1}
          max={50}
          value={maxCandidates}
          onChange={(value) => setMaxCandidates(value ?? 1)}
        />
      </ParamRow>

      <Divider style={{ margin: "12px 0" }} />

      <Text strong style={{ display: "block", marginBottom: 4 }}>
        Offline predictions
      </Text>
      <Text type="secondary" style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
        Optional: upload a CSV of candidate names computed by another method (e.g. a
        "SEG1"/"NEURON_ID"/"score" export). Scores merge into the same candidate list as live Run
        results, shown separately by source, so both can be compared side by side.
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

      <Divider style={{ margin: "12px 0" }} />

      <Tooltip
        title={
          !allowUpdate
            ? "Open an editable annotation to run prediction."
            : referenceDataset == null
              ? "Select a reference dataset first."
              : undefined
        }
      >
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          disabled={!allowUpdate || referenceDataset == null}
          loading={isRunning}
          onClick={handleRun}
          block
        >
          Run prediction
        </Button>
      </Tooltip>
    </div>
  );
}
