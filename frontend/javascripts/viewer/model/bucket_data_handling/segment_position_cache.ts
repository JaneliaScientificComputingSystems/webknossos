/*
 * Incremental, client-side "segment ID -> a real position" cache, populated
 * entirely as a side effect of normal viewing (panning/zooming/scrolling).
 * No extra network requests: every segmentation bucket the app fetches for
 * rendering is scanned once for its distinct segment IDs via the bucket's
 * own (already-computed, cached) value set, and the first bucket seen for
 * each new ID is recorded as that segment's position.
 *
 * This complements (does not replace) the precomputed segment-index / mesh-
 * file position lookups in predictions_view.tsx: those cover segments
 * anywhere in the dataset via a precomputed index, but require one to exist
 * for the layer. This cache has no such requirement, but only knows about
 * segments in buckets that have actually been loaded during this session —
 * it can't find a segment nobody has scrolled near.
 *
 * As a bonus, any cached position for a segment that's in the segment list
 * but missing an anchorPosition is written straight into Redux, from TWO
 * independent triggers:
 *   1. A bucket loads containing a segment ID that's ALREADY in the list
 *      (handled inline in recordBucket).
 *   2. A segment is ADDED to the list for an ID this cache already knows a
 *      position for — e.g. scrolling past a region first (caching 229 IDs
 *      locally, none in the list yet, so trigger 1 never fires for them),
 *      THEN running predictions, which creates list entries for those same
 *      229 IDs. Without this second trigger, the cache would have "known"
 *      positions for all of them yet never write any in, since trigger 1
 *      only fires on bucket load, not on list membership change. Handled by
 *      a store subscription per layer (see watchSegmentListForLayer),
 *      registered lazily the first time a bucket is seen for that layer.
 * Segment IDs that aren't already in the segment list are only cached
 * locally, never used to create a new segment-list entry — scrolling past a
 * segment you're not otherwise working with shouldn't silently add it.
 */
import { getSegmentationLayerByName } from "viewer/model/accessors/dataset_accessor";
import { getSegmentsForLayer } from "viewer/model/accessors/volumetracing_accessor";
import {
  batchUpdateGroupsAndSegmentsAction,
  updateSegmentAction,
} from "viewer/model/actions/volumetracing_actions";
import Constants, { type Vector3 } from "viewer/constants";
import { listenToStoreProperty } from "viewer/model/helpers/listener_helpers";
import Store from "viewer/store";
import type { DataBucket } from "./bucket";

const positionsByLayerName = new Map<string, Map<bigint, Vector3>>();
// Segment IDs already checked against the cache by the store-subscription
// path, per layer — so re-renders that don't add new segments don't rescan
// the whole map every time.
const checkedSegmentIdsByLayerName = new Map<string, Set<bigint>>();
const watchedLayerNames = new Set<string>();

function getOrCreateLayerCache(layerName: string): Map<bigint, Vector3> {
  let cache = positionsByLayerName.get(layerName);
  if (cache == null) {
    cache = new Map();
    positionsByLayerName.set(layerName, cache);
  }
  return cache;
}

/**
 * Convert a linear index into `bucket.data` to a real global (mag1) voxel
 * position. Bucket data is a flat BUCKET_WIDTH^3 array with x fastest, then
 * y, then z (see DataCube.getVoxelIndexByVoxelOffset) — this is the inverse
 * of that indexing, combined with the bucket's own mag1 origin and mag
 * scale factor. A CRITICAL property to preserve: this must be a literal
 * voxel that actually carries the target segment ID, not merely "near" it —
 * other WK code (e.g. rewrite_for_reapplying_sagas.ts) reads the data value
 * AT anchorPosition back to recover the segment's ID, so an approximate or
 * bucket-corner position would silently resolve to the wrong segment.
 */
function localIndexToGlobalPosition(bucket: DataBucket, linearIndex: number): Vector3 {
  const width = Constants.BUCKET_WIDTH;
  const z = Math.floor(linearIndex / width ** 2);
  const remainder = linearIndex % width ** 2;
  const y = Math.floor(remainder / width);
  const x = remainder % width;
  const origin = bucket.getGlobalPosition();
  const bucketMag = bucket.cube.magInfo.getMagByIndexOrThrow(bucket.zoomedAddress[3]);
  return [
    origin[0] + x * bucketMag[0],
    origin[1] + y * bucketMag[1],
    origin[2] + z * bucketMag[2],
  ];
}

/** Record one real voxel position per not-yet-seen segment ID in this bucket, keyed by this layer. */
function recordBucket(layerName: string, bucket: DataBucket): void {
  const cache = getOrCreateLayerCache(layerName);
  const valueSet = bucket.getValueSet();
  if (valueSet.size === 0) {
    return;
  }
  const idsToLocate = new Set<bigint>();
  for (const value of valueSet) {
    const segmentId = typeof value === "bigint" ? value : BigInt(value);
    if (!cache.has(segmentId)) {
      idsToLocate.add(segmentId);
    }
  }
  if (idsToLocate.size === 0) {
    return;
  }
  const data = bucket.getData();
  const newlyDiscovered = new Map<bigint, Vector3>();
  for (let index = 0; index < data.length && idsToLocate.size > 0; index++) {
    const segmentId = typeof data[index] === "bigint" ? (data[index] as bigint) : BigInt(data[index]);
    if (idsToLocate.has(segmentId)) {
      const position = localIndexToGlobalPosition(bucket, index);
      cache.set(segmentId, position);
      newlyDiscovered.set(segmentId, position);
      idsToLocate.delete(segmentId);
    }
  }
  if (newlyDiscovered.size > 0) {
    backfillExistingSegmentPositions(layerName, newlyDiscovered);
  }
}

/**
 * For IDs already in this layer's segment list but missing a position, write
 * it in directly — as a single batched dispatch. A plain per-segment
 * dispatch loop runs the reducer + diffing saga + a re-render once per
 * segment, synchronously; scrolling past a bucket with many newly-resolved
 * segments would otherwise cause visibly stale/dropped UI updates (some
 * writes landing in Redux but not being reflected until an unrelated
 * re-render, e.g. a manual page reload, picked them all up at once).
 */
function backfillExistingSegmentPositions(
  layerName: string,
  positionsBySegmentId: Map<bigint, Vector3>,
): void {
  let segments: ReturnType<typeof getSegmentsForLayer>;
  try {
    // Layer might not (yet) be a real segmentation layer in the dataset, or
    // might have no volume tracing/local segmentation state set up yet —
    // either is a normal transient state while a dataset is still loading,
    // not something worth surfacing.
    getSegmentationLayerByName(Store.getState().dataset, layerName);
    segments = getSegmentsForLayer(Store.getState(), layerName);
  } catch (_exception) {
    return;
  }
  const actions = [];
  for (const [segmentId, position] of positionsBySegmentId) {
    const segment = segments.getNullable(segmentId);
    if (segment != null && segment.anchorPosition == null) {
      actions.push(updateSegmentAction(segmentId, { anchorPosition: position }, layerName));
    }
  }
  if (actions.length > 0) {
    // Must use batchUpdateGroupsAndSegmentsAction, not a raw batchActions
    // call with an invented label — the save-queue-filling saga only wakes
    // up for action TYPES listed in VolumeTracingSaveRelevantActions, and a
    // novel batch label isn't one of them, so the write would silently never
    // reach the save queue/backend and be lost on reload.
    Store.dispatch(batchUpdateGroupsAndSegmentsAction(actions));
  }
}

/**
 * Check every segment currently in this layer's list against the cache,
 * writing in any cached position for a segment that's missing one. Run once
 * up front (when watching starts) and again on every subsequent change to
 * the segment list, so segments added AFTER their position was already
 * cached (e.g. scroll first, predict later) still get backfilled — the
 * bucket-load trigger in recordBucket only fires for segments already
 * listed at the moment their bucket loads, which misses this ordering.
 */
function checkSegmentListAgainstCache(layerName: string): void {
  const cache = positionsByLayerName.get(layerName);
  if (cache == null || cache.size === 0) {
    return;
  }
  let checkedIds = checkedSegmentIdsByLayerName.get(layerName);
  if (checkedIds == null) {
    checkedIds = new Set();
    checkedSegmentIdsByLayerName.set(layerName, checkedIds);
  }
  let segments: ReturnType<typeof getSegmentsForLayer>;
  try {
    getSegmentationLayerByName(Store.getState().dataset, layerName);
    segments = getSegmentsForLayer(Store.getState(), layerName);
  } catch (_exception) {
    return;
  }
  const actions = [];
  for (const segment of segments.values()) {
    if (checkedIds.has(segment.id)) {
      continue;
    }
    checkedIds.add(segment.id);
    if (segment.anchorPosition != null) {
      continue;
    }
    const cachedPosition = cache.get(segment.id);
    if (cachedPosition != null) {
      actions.push(updateSegmentAction(segment.id, { anchorPosition: cachedPosition }, layerName));
    }
  }
  if (actions.length > 0) {
    Store.dispatch(batchUpdateGroupsAndSegmentsAction(actions));
  }
}

/** Start watching this layer's segment list for newly-added segments, lazily, once per layer. */
function watchSegmentListForLayer(layerName: string): void {
  if (watchedLayerNames.has(layerName)) {
    return;
  }
  watchedLayerNames.add(layerName);
  listenToStoreProperty(
    (state) => {
      try {
        getSegmentationLayerByName(state.dataset, layerName);
        return getSegmentsForLayer(state, layerName);
      } catch (_exception) {
        return null;
      }
    },
    () => checkSegmentListAgainstCache(layerName),
  );
}

/**
 * Subscribe a newly-created segmentation bucket to this cache. Call once per
 * bucket, right after creation (see DataCube.createBucket) — a no-op for
 * non-segmentation buckets. Safe to call unconditionally; unsubscribes
 * itself when the bucket is garbage-collected.
 */
export function registerBucketForSegmentPositionCache(
  layerName: string,
  bucket: DataBucket,
): void {
  if (!bucket.cube.isSegmentation) {
    return;
  }
  watchSegmentListForLayer(layerName);
  const unsubscribe = bucket.on("bucketLoaded", () => recordBucket(layerName, bucket));
  bucket.once("bucketCollected", unsubscribe);
}

/** Best-effort lookup: a real position for this segment, if any loaded bucket has contained it so far this session. */
export function getCachedSegmentPosition(
  layerName: string,
  segmentId: bigint,
): Vector3 | undefined {
  return positionsByLayerName.get(layerName)?.get(segmentId);
}
