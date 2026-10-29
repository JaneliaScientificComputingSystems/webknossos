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
  getRegisteredAtlases,
  type NuclearInputNode,
  type NuclearPredictRequestPayload,
  type RegisteredAtlas,
  requestNuclearPredictions,
} from "viewer/view/right_border_tabs/predictions_tab/nuclear_prediction_client";
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
  type PredictionMode,
  parseConfigFromDescription,
} from "viewer/view/right_border_tabs/predictions_tab/prediction_config_persistence";

// Keyed by reference dataset, not a single shared constant, so predictions
// against different Witvliet stages are kept as parallel scores per name
// instead of the later run silently overwriting the earlier one's score.
function predictionSourceFor(referenceDataset: string): string {
  return `prediction:${referenceDataset}`;
}

export function atlasKeyFor(embryo: string, timepoint: number): string {
  return `${embryo}|${timepoint}`;
}

function parseAtlasKey(key: string): { embryo: string; timepoint: number } {
  const separatorIndex = key.lastIndexOf("|");
  return {
    embryo: key.slice(0, separatorIndex),
    timepoint: Number(key.slice(separatorIndex + 1)),
  };
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

  // Which service the Configuration tab currently shows inputs for.
  // Switching modes doesn't clear the other mode's config (contactEdges/
  // selectedReferenceDatasets vs. selectedEmbryo/selectedTimepoint/nTrials
  // below all persist independently of this), so toggling back and forth
  // doesn't lose anything already set up.
  const [predictionMode, setPredictionMode] = useState<PredictionMode>("contactome");

  // Names excluded from the reference contactome used for live Run matching,
  // and from Search by Name's autocomplete suggestions elsewhere in the
  // neuron-identity panel. Persisted into annotation.description (see
  // prediction_config_persistence.ts) alongside the contact profile below, so
  // both survive a reload/new session instead of resetting every time.
  const [ignoredNames, setIgnoredNames] = useState<string[]>([]);

  const [selectedReferenceDatasets, setSelectedReferenceDatasets] = useState<Set<string>>(
    new Set(),
  );

  // Nuclear-position service inputs — one or more already-registered
  // reference atlases to match against (registered on the service
  // out-of-band, not from this UI), keyed as "embryo|timepoint" strings
  // (mirroring selectedReferenceDatasets's Set<string> shape) so multiple
  // atlases can be checked at once, same as contactome's reference-dataset
  // checkboxes; nTrials controls the ensemble size behind the service's
  // confidence scores.
  const [selectedAtlasKeys, setSelectedAtlasKeys] = useState<Set<string>>(new Set());
  const [nTrials, setNTrials] = useState(20);
  const [registeredAtlases, setRegisteredAtlases] = useState<RegisteredAtlas[]>([]);
  const [registeredAtlasesStatus, setRegisteredAtlasesStatus] = useState<
    "loading" | "loaded" | "failed"
  >("loading");
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

  // Populate the embryo/timepoint picker from the nuclear service itself —
  // same reasoning as the contactome reference-dataset fetch above, it's
  // the service (not the frontend) that knows which atlases are currently
  // registered and can actually be matched against.
  useEffect(() => {
    let cancelled = false;
    getRegisteredAtlases().then(
      (atlases) => {
        if (cancelled) {
          return;
        }
        setRegisteredAtlases(atlases);
        setRegisteredAtlasesStatus("loaded");
      },
      () => {
        if (!cancelled) {
          setRegisteredAtlasesStatus("failed");
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

  const toggleAtlas = (embryo: string, timepoint: number, checked: boolean) => {
    const key = atlasKeyFor(embryo, timepoint);
    setSelectedAtlasKeys((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
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
      setPredictionMode(persisted.predictionMode);
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
      setSelectedAtlasKeys(new Set(persisted.selectedAtlasKeys));
      setNTrials(persisted.nTrials);
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
      predictionMode,
      contactEdges,
      contactFileName,
      contactUploadedAt,
      ignoredNames,
      lastRunConfirmedNames:
        lastRunConfirmedNames != null ? Array.from(lastRunConfirmedNames) : null,
      selectedReferenceDatasets: Array.from(selectedReferenceDatasets),
      selectedAtlasKeys: Array.from(selectedAtlasKeys),
      nTrials,
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
    predictionMode,
    contactEdges,
    contactFileName,
    contactUploadedAt,
    ignoredNames,
    lastRunConfirmedNames,
    selectedReferenceDatasets,
    selectedAtlasKeys,
    nTrials,
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
      // is a type-level cast, not a runtime assumption. The composite
      // action's own type MUST be "BATCH_UPDATE_GROUPS_AND_TREES" (not an
      // invented label) — SkeletonTracingSaveRelevantActions only watches
      // for that exact type string to feed the save queue; any other label
      // updates the in-memory Redux state (so the UI looks right) but is
      // silently never persisted, which is why confirmed identities were
      // reverting on page refresh.
      dispatch(
        batchActions(actions, "BATCH_UPDATE_GROUPS_AND_TREES") as unknown as SkeletonTracingAction,
      );
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

  const canRunContactome =
    allowUpdate && contactEdges.length > 0 && selectedReferenceDatasets.size > 0;
  const canRunNuclear = allowUpdate && selectedAtlasKeys.size > 0;
  const canRun = !isRunning && (predictionMode === "contactome" ? canRunContactome : canRunNuclear);

  const runContactome = async () => {
    if (trees == null || contactEdges.length === 0 || selectedReferenceDatasets.size === 0) {
      return;
    }
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
  };

  const runNuclear = async () => {
    if (trees == null || selectedAtlasKeys.size === 0) {
      return;
    }
    // Every non-ignored tree in the skeleton is a query target — unlike the
    // contactome mode, there's no uploaded file defining which trees matter;
    // the nuclear service matches against whatever's actually in the
    // skeleton layer, using each tree's own node position. Built once since
    // it doesn't depend on which atlas is being matched against.
    const requestNodes: NuclearInputNode[] = Array.from(trees.values())
      .filter((tree) => !getTreeIdentity(tree).ignored)
      .map((tree) => {
        const node = tree.nodes.values().next().value;
        const identity = getTreeIdentity(tree);
        return {
          id: tree.treeId,
          position: node != null ? node.untransformedPosition : [0, 0, 0],
          name: identity.confirmed,
          is_confirmed: identity.confirmed != null,
        };
      });

    // One request + one write per checked atlas, run in sequence rather
    // than in parallel — same reasoning as runContactome's loop: these all
    // write to the same trees' metadata, and writeMergedCandidates reads
    // each tree's CURRENT metadata before merging in its own source's
    // entry, so running them concurrently could let one run's read miss
    // another's not-yet-dispatched write.
    let totalWritten = 0;
    const failedAtlases: string[] = [];
    for (const atlasKey of selectedAtlasKeys) {
      const { embryo, timepoint } = parseAtlasKey(atlasKey);
      const payload: NuclearPredictRequestPayload = {
        nodes: requestNodes,
        embryo,
        timepoint,
        n_trials: nTrials,
      };

      let response: Awaited<ReturnType<typeof requestNuclearPredictions>>;
      try {
        response = await requestNuclearPredictions(payload);
      } catch (exception) {
        failedAtlases.push(atlasKey);
        Toast.error(
          `${embryo}/t${timepoint}: ${
            exception instanceof Error
              ? exception.message
              : "Could not reach the nuclear prediction service."
          }`,
        );
        continue;
      }

      const { written } = writeMergedCandidates(
        nuclearPredictionSourceFor(embryo, timepoint),
        response.predictions.map((prediction) => ({
          segment_id: prediction.node_id,
          candidates: prediction.candidates,
        })),
      );
      totalWritten += written;
    }

    if (totalWritten > 0) {
      const atlasCount = selectedAtlasKeys.size - failedAtlases.length;
      Toast.success(
        `Predicted identities for ${totalWritten} tree(s) against ${atlasCount} atlas(es).`,
      );
    }
  };

  const run = async () => {
    if (trees == null) {
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

      if (predictionMode === "contactome") {
        await runContactome();
      } else {
        await runNuclear();
      }
    } finally {
      setIsRunning(false);
    }
  };

  return {
    allowUpdate,
    predictionMode,
    setPredictionMode,
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
    selectedAtlasKeys,
    toggleAtlas,
    nTrials,
    setNTrials,
    registeredAtlases,
    registeredAtlasesStatus,
    isRunning,
    canRun,
    run,
    writeMergedCandidates,
    lastRunConfirmedNames,
  };
}

// Keyed by embryo+timepoint, not a single shared constant, so predictions
// against different reference atlases are kept as parallel scores per name
// instead of the later run silently overwriting the earlier one's score.
function nuclearPredictionSourceFor(embryo: string, timepoint: number): string {
  return `prediction:nuclear:${embryo}:${timepoint}`;
}

function annotationDescriptionAtMount(): string {
  return Store.getState().annotation.description;
}

export type PredictionConfigurationState = ReturnType<typeof usePredictionConfigurationState>;
