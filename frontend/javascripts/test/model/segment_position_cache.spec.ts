import Constants from "viewer/constants";
import type * as SegmentPositionCache from "viewer/model/bucket_data_handling/segment_position_cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeSegment = { id: bigint; anchorPosition: [number, number, number] | null };

const mocks = vi.hoisted(() => ({
  annotationId: "annotation-a",
  segments: [] as FakeSegment[],
  dispatch: vi.fn(),
  // onChange callbacks registered via listenToStoreProperty, so a test can
  // simulate the segment list changing.
  storePropertyListeners: [] as Array<() => void>,
}));

vi.mock("viewer/store", () => ({
  default: {
    getState: () => ({ annotation: { annotationId: mocks.annotationId }, dataset: {} }),
    dispatch: mocks.dispatch,
  },
}));

vi.mock("viewer/model/accessors/dataset_accessor", () => ({
  getSegmentationLayerByName: () => ({}),
}));

vi.mock("viewer/model/accessors/volumetracing_accessor", () => ({
  getSegmentsForLayer: () => ({
    getNullable: (id: bigint) => mocks.segments.find((segment) => segment.id === id),
    values: () => mocks.segments.values(),
  }),
}));

vi.mock("viewer/model/actions/volumetracing_actions", () => ({
  updateSegmentAction: (id: bigint, segment: object, layerName: string) => ({
    type: "UPDATE_SEGMENT",
    id,
    segment,
    layerName,
  }),
  batchUpdateGroupsAndSegmentsAction: (actions: object[]) => ({
    type: "BATCH_UPDATE_GROUPS_AND_SEGMENTS",
    actions,
  }),
}));

vi.mock("viewer/model/helpers/listener_helpers", () => ({
  listenToStoreProperty: (_select: unknown, onChange: () => void) => {
    mocks.storePropertyListeners.push(onChange);
    return () => {};
  },
}));

const LAYER_NAME = "segmentation";
const SEGMENT_ID = 5n;

// A segmentation bucket containing SEGMENT_ID in its first voxel, at global
// position [64, 0, 0] (mag 1).
function createFakeBucket() {
  const loadedListeners: Array<() => void> = [];
  const data = new Uint32Array(Constants.BUCKET_WIDTH ** 3);
  data[0] = Number(SEGMENT_ID);
  return {
    cube: { isSegmentation: true, magInfo: { getMagByIndexOrThrow: () => [1, 1, 1] } },
    zoomedAddress: [2, 0, 0, 0],
    getGlobalPosition: () => [64, 0, 0],
    getValueSet: () => new Set([Number(SEGMENT_ID)]),
    getData: () => data,
    on: vi.fn((_event: string, listener: () => void) => {
      loadedListeners.push(listener);
      return () => {};
    }),
    once: vi.fn(),
    triggerLoaded: () => {
      for (const listener of loadedListeners) listener();
    },
  };
}

// A fresh module instance per test (see vi.resetModules in beforeEach), loaded
// through vitest rather than a bare dynamic import, which the repo lint forbids.
async function importCache() {
  return vi.importActual<typeof SegmentPositionCache>(
    "viewer/model/bucket_data_handling/segment_position_cache",
  );
}

function dispatchedAnchorPositions() {
  return mocks.dispatch.mock.calls.flatMap(([batch]) =>
    batch.actions.map(
      (action: { segment: { anchorPosition: number[] } }) => action.segment.anchorPosition,
    ),
  );
}

describe("segment_position_cache", () => {
  beforeEach(() => {
    // Module state (flag, cache) lives in the module, so start each test fresh.
    vi.resetModules();
    mocks.annotationId = "annotation-a";
    mocks.segments = [{ id: SEGMENT_ID, anchorPosition: null }];
    mocks.dispatch.mockClear();
    mocks.storePropertyListeners.length = 0;
  });

  it("does not register buckets or write anything while not opted in", async () => {
    const cache = await importCache();
    const bucket = createFakeBucket();

    cache.registerBucketForSegmentPositionCache(LAYER_NAME, bucket as never);

    expect(bucket.on).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("writes a cached anchor position for a listed segment when opted in", async () => {
    const cache = await importCache();
    cache.setSegmentPositionCacheEnabled(true);
    const bucket = createFakeBucket();

    cache.registerBucketForSegmentPositionCache(LAYER_NAME, bucket as never);
    bucket.triggerLoaded();

    expect(dispatchedAnchorPositions()).toEqual([[64, 0, 0]]);
  });

  it("stops writing as soon as it is turned off, without a reload", async () => {
    const cache = await importCache();
    cache.setSegmentPositionCacheEnabled(true);
    const bucket = createFakeBucket();
    cache.registerBucketForSegmentPositionCache(LAYER_NAME, bucket as never);

    cache.setSegmentPositionCacheEnabled(false);
    bucket.triggerLoaded();
    for (const onChange of mocks.storePropertyListeners) onChange();

    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not carry the opt-in or cached positions over to another annotation", async () => {
    const cache = await importCache();
    cache.setSegmentPositionCacheEnabled(true);
    const bucket = createFakeBucket();
    cache.registerBucketForSegmentPositionCache(LAYER_NAME, bucket as never);
    mocks.segments = [];
    bucket.triggerLoaded(); // caches the position without writing (segment not listed)
    expect(cache.getCachedSegmentPosition(LAYER_NAME, SEGMENT_ID)).toEqual([64, 0, 0]);

    // Open another annotation (same page, no reload) whose list contains a
    // segment with the same id on a layer with the same name.
    mocks.annotationId = "annotation-b";
    mocks.segments = [{ id: SEGMENT_ID, anchorPosition: null }];

    expect(cache.isSegmentPositionCacheEnabled()).toBe(false);
    expect(cache.getCachedSegmentPosition(LAYER_NAME, SEGMENT_ID)).toBeUndefined();
    bucket.triggerLoaded();
    for (const onChange of mocks.storePropertyListeners) onChange();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
