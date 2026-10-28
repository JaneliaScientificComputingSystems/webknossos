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

import { useWkSelector } from "libs/react_hooks";
import Toast from "libs/toast";
import { useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import { batchActions } from "redux-batched-actions";
import { getSkeletonTracing } from "viewer/model/accessors/skeletontracing_accessor";
import { setAnnotationDescriptionAction } from "viewer/model/actions/annotation_actions";
import type { SkeletonTracingAction } from "viewer/model/actions/skeletontracing_actions";
import {
  setTreeMetadataAction,
  setTreeNameAction,
} from "viewer/model/actions/skeletontracing_actions";
import { waitUntilRebaseFinished } from "viewer/model/helpers/bounding_box_creation_helpers";
import Store from "viewer/store";
import {
  getTreeIdentity,
  withConfirmedIdentity,
  withMergedCandidates,
} from "viewer/view/right_border_tabs/neuron_identity_tab/neuron_identity_metadata";
import {
  type ContactEdge,
  getDistinctNeuronIds,
} from "viewer/view/right_border_tabs/predictions_tab/contact_profile";
import {
  getReferenceDatasets,
  type NodePredictionPayload,
  type PredictionServiceInputNode,
  type PredictRequestPayload,
  type PredictResponsePayload,
  requestPredictions,
} from "viewer/view/right_border_tabs/predictions_tab/prediction_client";
import {
  encodeConfigIntoDescription,
  parseConfigFromDescription,
} from "viewer/view/right_border_tabs/predictions_tab/prediction_config_persistence";

// Keyed by reference dataset, not a single shared constant, so predictions
// against different Witvliet stages are kept as parallel scores per name
// instead of the later run silently overwriting the earlier one's score.
function predictionSourceFor(referenceDataset: string): string {
  return `prediction:${referenceDataset}`;
}

export type WriteResult = {
  written: number;
  /** Prediction response entries that referenced a tree ID with no matching existing tree — this panel never creates trees (see module doc), so these are skipped rather than materialized. */
  skippedMissingTreeCount: number;
  /** Only meaningful when writeMergedCandidates was called with autoConfirm. */
  confirmedCount: number;
  skippedConfirmCount: number;
};

export function usePredictionConfigurationState() {
  const dispatch = useDispatch();
  const skeletonTracing = useWkSelector((state) => getSkeletonTracing(state.annotation));
  const trees = skeletonTracing?.trees;
  const allowUpdate = useWkSelector(
    (state) =>
      state.annotation.skeleton != null &&
      state.annotation.restrictions.allowUpdate &&
      !state.annotation.isLockedByOwner,
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

  // Contact profile: a weighted contact graph between trees, dropped as a
  // CSV/TSV file. Persisted (as parsed edges, not the raw file text) into
  // annotation.description — see prediction_config_persistence.ts for why
  // that field and how it coexists with the human-written description.
  const [contactEdges, setContactEdges] = useState<ContactEdge[]>([]);
  const [contactFileName, setContactFileName] = useState<string | null>(null);
  const [contactUploadedAt, setContactUploadedAt] = useState<number | null>(null);

  // Guards the save effect below until the render in which the state restored
  // by the one-time load effect is visible. A ref would already be true when
  // the save effect runs right after the load effect on mount, so mount would
  // "save" the still-empty initial state over whatever was persisted.
  const [hasLoadedPersistedConfig, setHasLoadedPersistedConfig] = useState(false);
  // Only the newest pending write may land (see waitUntilRebaseFinished below).
  const latestConfigWriteId = useRef(0);
  useEffect(() => {
    const persisted = parseConfigFromDescription(annotationDescriptionAtMount());
    if (persisted != null) {
      setContactEdges(persisted.contactEdges);
      setContactFileName(persisted.contactFileName);
      setContactUploadedAt(persisted.contactUploadedAt);
      setIgnoredNames(persisted.ignoredNames);
      setLastRunConfirmedNames(
        persisted.lastRunConfirmedNames != null ? new Set(persisted.lastRunConfirmedNames) : null,
      );
      if (persisted.selectedReferenceDatasets.length > 0) {
        setSelectedReferenceDatasets(new Set(persisted.selectedReferenceDatasets));
      }
    }
    setHasLoadedPersistedConfig(true);
    // Intentionally run once on mount only (new annotation.description
    // values written by THIS hook's own save effect below must not re-trigger
    // a reload, or every save would immediately read itself back).
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, []);

  useEffect(() => {
    if (!hasLoadedPersistedConfig) {
      return;
    }
    const config = {
      contactEdges,
      contactFileName,
      contactUploadedAt,
      ignoredNames,
      lastRunConfirmedNames:
        lastRunConfirmedNames != null ? Array.from(lastRunConfirmedNames) : null,
      selectedReferenceDatasets: Array.from(selectedReferenceDatasets),
    };
    latestConfigWriteId.current += 1;
    const configWriteId = latestConfigWriteId.current;
    // A description change made while a rebase/forwarding round is running
    // isn't saved and gets replaced by the server's version (same as the Info
    // tab's description edit), so wait for it to finish first.
    waitUntilRebaseFinished().then(() => {
      if (configWriteId !== latestConfigWriteId.current) {
        return;
      }
      const currentDescription = Store.getState().annotation.description;
      const nextDescription = encodeConfigIntoDescription(currentDescription, config);
      if (nextDescription === currentDescription) {
        return;
      }
      dispatch(setAnnotationDescriptionAction(nextDescription));
    });
    // annotation.description is deliberately not a dependency (it's read from
    // the store at write time): including it would re-run this effect on every
    // description change from ANYWHERE, not just from this hook's own state.
  }, [
    hasLoadedPersistedConfig,
    contactEdges,
    contactFileName,
    contactUploadedAt,
    ignoredNames,
    lastRunConfirmedNames,
    selectedReferenceDatasets,
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
  // produce a batch of (tree, candidates) writes that must land in a
  // SINGLE dispatch. This panel never creates trees (see module doc) — a
  // prediction response entry whose node_id/segment_id has no matching
  // existing tree is skipped, not materialized, since tree creation is
  // collab-restricted and this feature does no collaborative tree creation.
  const writeMergedCandidates = (
    source: string,
    predictions: NodePredictionPayload[],
    // Seeds (ground-truth assignments, as opposed to a model's guesses) are
    // auto-confirmed rather than left for the user to click — but only when
    // unambiguous: a prediction with more than one candidate name isn't a
    // seed assignment, and a conflicting confirm (this tree already
    // confirmed as something else, or this name already confirmed on a
    // DIFFERENT tree — checked against both pre-existing state and
    // earlier rows in this same batch) is skipped, leaving the candidate
    // written but unconfirmed for manual review.
    options?: { autoConfirm?: boolean },
  ): WriteResult => {
    if (trees == null) {
      return { written: 0, skippedMissingTreeCount: 0, confirmedCount: 0, skippedConfirmCount: 0 };
    }

    // Names already confirmed elsewhere, as of before this batch — the
    // baseline conflict check for auto-confirm. Names claimed by an EARLIER
    // row within this same batch are tracked separately as the batch is
    // built below, so two seed rows in the same file can't both claim the
    // same name either.
    const confirmedNamesAtStart = new Set<string>();
    if (options?.autoConfirm) {
      for (const existingTree of trees.values()) {
        const confirmed = getTreeIdentity(existingTree).confirmed;
        if (confirmed != null) {
          confirmedNamesAtStart.add(confirmed);
        }
      }
    }
    const namesClaimedThisBatch = new Set<string>();

    const predictedAt = Date.now();
    let skippedMissingTreeCount = 0;
    let confirmedCount = 0;
    let skippedConfirmCount = 0;
    const actions = predictions.flatMap((prediction) => {
      const treeId = prediction.segment_id;
      const tree = trees.getNullable(treeId);
      if (tree == null) {
        skippedMissingTreeCount += 1;
        return [];
      }
      let metadata = withMergedCandidates(
        tree.metadata ?? [],
        source,
        prediction.candidates,
        predictedAt,
      );
      let confirmedName: string | null = null;
      if (options?.autoConfirm && prediction.candidates.length === 1) {
        const name = prediction.candidates[0].name;
        const existingConfirmed = getTreeIdentity(tree).confirmed;
        const conflicts =
          (existingConfirmed != null && existingConfirmed !== name) ||
          confirmedNamesAtStart.has(name) ||
          namesClaimedThisBatch.has(name);
        if (conflicts) {
          skippedConfirmCount += 1;
        } else {
          namesClaimedThisBatch.add(name);
          confirmedCount += 1;
          metadata = withConfirmedIdentity(metadata, name);
          confirmedName = name;
        }
      }
      return [
        ...(confirmedName != null ? [setTreeNameAction(confirmedName, treeId)] : []),
        setTreeMetadataAction(metadata, treeId),
      ];
    });

    if (actions.length > 0) {
      // batchActions (not the narrower-typed batchUpdateGroupsAndTreesAction
      // helper) is used directly here since SET_TREE_NAME/SET_TREE_METADATA
      // aren't in BatchableUpdateTreeAction's allowlist — the reducer-level
      // `enableBatching` wrapper replays any action array regardless of that
      // TS-only restriction (see scratch/tree_identity_port_plan.md), so this
      // is a type-level cast, not a runtime assumption.
      dispatch(batchActions(actions, "BATCH_UPDATE_IDENTITY") as unknown as SkeletonTracingAction);
    }
    if (skippedMissingTreeCount > 0) {
      Toast.info(
        `${skippedMissingTreeCount} prediction(s) referenced a tree that doesn't exist yet and were skipped.`,
      );
    }
    return {
      written: predictions.length - skippedMissingTreeCount,
      skippedMissingTreeCount,
      confirmedCount,
      skippedConfirmCount,
    };
  };

  const canRun =
    allowUpdate && contactEdges.length > 0 && selectedReferenceDatasets.size > 0 && !isRunning;

  const run = async () => {
    if (trees == null) {
      return;
    }
    if (contactEdges.length === 0 || selectedReferenceDatasets.size === 0) {
      return;
    }
    setIsRunning(true);
    try {
      // Snapshot every currently-confirmed name across ALL trees (not just
      // this run's targets) — this is the baseline the Confirmed IDs box
      // diffs against afterward to show what's changed since this Run.
      const confirmedNamesAtRunStart = new Set<string>();
      for (const tree of trees.values()) {
        const confirmed = getTreeIdentity(tree).confirmed;
        if (confirmed != null) {
          confirmedNamesAtRunStart.add(confirmed);
        }
      }
      setLastRunConfirmedNames(confirmedNamesAtRunStart);

      // The contact profile's neurons are the prediction targets, regardless
      // of whether they're already in the local tree list — a fresh
      // contact profile commonly references trees the user hasn't clicked
      // on yet. Build each entry from the live tree if one already
      // exists (so its real name/confirmed status reaches the service),
      // falling back to a minimal placeholder otherwise. Read fresh at click
      // time so trees added after the file was loaded (e.g. via
      // proofreading in between Run clicks) are picked up too.
      // Trees marked "ignore (not a real cell)" are dropped entirely —
      // from both the targets AND any contact edge that references them —
      // so they're never sent to the matcher at all.
      const ignoredIds = new Set(
        Array.from(trees.values())
          .filter((tree) => getTreeIdentity(tree).ignored)
          .map((tree) => tree.treeId),
      );
      const targetIds = getDistinctNeuronIds(contactEdges).filter((id) => !ignoredIds.has(id));
      const requestNodes: PredictionServiceInputNode[] = targetIds.map((treeId) => {
        const tree = trees.getNullable(treeId);
        if (tree == null) {
          return { id: treeId, name: null, is_confirmed: false };
        }
        const identity = getTreeIdentity(tree);
        return {
          // The CONFIRMED identity name, not WK's native tree.name field
          // (set independently of this feature's confirmation system) —
          // using tree.name here would send is_confirmed: true paired with
          // name: null for every confirmed tree, which the service
          // rejected (a seed needs both to be set).
          id: tree.treeId,
          name: identity.confirmed,
          is_confirmed: identity.confirmed != null,
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
      // trees' metadata, and writeMergedCandidates reads each tree's
      // CURRENT metadata before merging in its own source's entry, so
      // running them concurrently could let one run's read miss another's
      // not-yet-dispatched write.
      let totalWritten = 0;
      const failedDatasets: string[] = [];
      for (const referenceDataset of selectedReferenceDatasets) {
        const payload: PredictRequestPayload = {
          segments: requestNodes,
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

        const { written } = writeMergedCandidates(
          predictionSourceFor(referenceDataset),
          response.predictions,
        );
        totalWritten += written;
      }

      if (totalWritten > 0) {
        const datasetCount = selectedReferenceDatasets.size - failedDatasets.length;
        Toast.success(
          `Predicted identities for ${totalWritten} tree(s) against ${datasetCount} dataset(s).`,
        );
      }
    } finally {
      setIsRunning(false);
    }
  };

  return {
    allowUpdate,
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

function annotationDescriptionAtMount(): string {
  return Store.getState().annotation.description;
}

export type PredictionConfigurationState = ReturnType<typeof usePredictionConfigurationState>;
