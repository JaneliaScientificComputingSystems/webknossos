/*
 * Wraps usePredictionConfigurationState() in a Context so any component
 * under <PredictionConfigurationProvider> can read/mutate the ID-prediction
 * feature's shared state (contact profile, reference-dataset selection,
 * ignored names, run status) via usePredictionConfiguration(), without
 * prop-drilling it down from wherever the provider happens to sit. Scoped to
 * this feature's own files rather than the app's global Redux store, to keep
 * the neuron-identity panel's state independent of the rest of webknossos.
 */
import { createContext, type ReactNode, useContext } from "react";
import {
  type PredictionConfigurationState,
  usePredictionConfigurationState,
} from "viewer/view/right_border_tabs/predictions_tab/prediction_configuration";

const PredictionConfigurationContext = createContext<PredictionConfigurationState | null>(null);

export function PredictionConfigurationProvider({ children }: { children: ReactNode }) {
  const state = usePredictionConfigurationState();
  return (
    <PredictionConfigurationContext.Provider value={state}>
      {children}
    </PredictionConfigurationContext.Provider>
  );
}

export function usePredictionConfiguration(): PredictionConfigurationState {
  const context = useContext(PredictionConfigurationContext);
  if (context == null) {
    throw new Error(
      "usePredictionConfiguration must be used within a PredictionConfigurationProvider",
    );
  }
  return context;
}
