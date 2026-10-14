// @vitest-environment jsdom
// Mounts the real usePredictionConfigurationState hook against a minimal fake store to check
// how the ID-prediction config is written back into annotation.description.
import type React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const dispatched: any[] = [];
  const state: any = {
    annotation: { annotationId: "a", description: "" },
    dataset: {},
    flycam: { additionalCoordinates: null },
    localSegmentationStateByLayer: {},
    save: { rebaseRelevantServerAnnotationState: { isRebasingOrForwarding: false } },
  };
  const store = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch: (action: any) => {
      dispatched.push(action);
      if (action.type === "SET_ANNOTATION_DESCRIPTION") {
        state.annotation = { ...state.annotation, description: action.description };
        for (const listener of listeners) listener();
      }
      return action;
    },
  };
  return { store, state, dispatched };
});

vi.mock("viewer/store", () => ({ default: mocks.store }));
vi.mock("react-redux", () => ({ useDispatch: () => mocks.store.dispatch }));
vi.mock("libs/react_hooks", async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof React>("react");
  return {
    useWkSelector: (selector: (state: any) => any) =>
      useSyncExternalStore(mocks.store.subscribe, () => selector(mocks.store.getState())),
  };
});
vi.mock("viewer/model/accessors/dataset_accessor", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMagInfo: () => null,
  getVisibleSegmentationLayer: () => null,
}));
const NO_SEGMENTS = { segments: null };
vi.mock("viewer/model/accessors/volumetracing_accessor", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCurrentMappingName: () => null,
  getVisibleSegments: () => NO_SEGMENTS,
}));
vi.mock("viewer/model/accessors/annotation_accessor", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  mayEditAnnotation: () => true,
}));
vi.mock("viewer/view/right_border_tabs/predictions_tab/prediction_client", () => ({
  getReferenceDatasets: () => Promise.resolve(["stage-1"]),
  requestPredictions: vi.fn(),
}));
vi.mock("viewer/model/helpers/bounding_box_creation_helpers", () => ({
  waitUntilRebaseFinished: () => Promise.resolve(),
}));

import {
  encodeConfigIntoDescription,
  parseConfigFromDescription,
} from "viewer/view/right_border_tabs/predictions_tab/prediction_config_persistence";
import { usePredictionConfigurationState } from "viewer/view/right_border_tabs/predictions_tab/prediction_configuration";

it("restores the cache opt-in without writing defaults, and saves a toggle at once", async () => {
  mocks.state.annotation.description = encodeConfigIntoDescription("Notes", {
    contactEdges: [],
    contactFileName: null,
    contactUploadedAt: null,
    ignoredNames: ["AVAL"],
    lastRunConfirmedNames: null,
    selectedReferenceDatasets: ["stage-1"],
    segmentPositionCacheEnabled: true,
  });
  let hookState: any;
  function Probe() {
    hookState = usePredictionConfigurationState();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(createElement(Probe));
  });
  await act(async () => {});

  const writtenConfigs = () =>
    mocks.dispatched
      .filter((action) => action.type === "SET_ANNOTATION_DESCRIPTION")
      .map((action) => parseConfigFromDescription(action.description));
  expect(hookState.segmentPositionCacheEnabled).toBe(true);
  expect(writtenConfigs()).toEqual([]);

  await act(async () => hookState.toggleSegmentPositionCache(false));
  await act(async () => {});
  expect(writtenConfigs().map((config) => config?.segmentPositionCacheEnabled)).toEqual([false]);
  expect(mocks.dispatched.at(-1).type).toBe("SAVE_NOW");
  expect(parseConfigFromDescription(mocks.state.annotation.description)?.ignoredNames).toEqual([
    "AVAL",
  ]);
  expect(mocks.state.annotation.description.startsWith("Notes")).toBe(true);
});
