/*
 * Client for the standalone neuron-identity (contactome) prediction service
 * (see celegans_contactome/service), which predicts identities for a whole
 * contactome in a single call. The types below mirror that service's
 * `app/schemas.py` field-for-field — read that file directly if this drifts,
 * rather than trusting this comment.
 *
 * This now runs against the SKELETON/tree layer instead of a segmentation
 * layer — the `id`/`segment_id` fields below refer to tree IDs, not segment
 * IDs. The service's own JSON contract (field names included) is UNCHANGED —
 * it only ever dealt in plain numeric IDs — only what those IDs mean on the
 * WK side has shifted, so the wire-format field name `segment_id` is kept
 * as-is rather than renamed, to avoid silently breaking deserialization.
 *
 * Plain `fetch` is used deliberately instead of WK's `Request` helper
 * (libs/request.ts): that helper is geared toward WK's own authenticated
 * endpoints, and this service takes no WK token by design.
 */
export type PredictionServiceInputNode = {
  id: number;
  name?: string | null;
  is_confirmed?: boolean;
};

export type PredictionServiceContactEdge = {
  neuron_a: number;
  neuron_b: number;
  weight: number;
};

export type PredictRequestPayload = {
  segments: PredictionServiceInputNode[];
  contact_edges: PredictionServiceContactEdge[];
  exclude_assigned_names?: boolean;
  reference_dataset: string;
  /** Neuron names to exclude from the reference contactome before matching. */
  ignored_names?: string[];
};

export type ServiceCandidate = {
  name: string;
  score: number;
};

export type NodePredictionPayload = {
  /** Wire-format name is unchanged from the service's actual JSON key; the value is a tree ID. */
  segment_id: number;
  candidates: ServiceCandidate[];
};

export type PredictResponsePayload = {
  reference_dataset: string;
  predictions: NodePredictionPayload[];
};

export type ReferenceDatasetNeuronsPayload = {
  reference_dataset: string;
  neuron_names: string[];
};

const DEFAULT_BASE_URL = "http://localhost:8010";

function getBaseUrl(): string {
  return import.meta.env.VITE_PREDICTION_SERVICE_URL ?? DEFAULT_BASE_URL;
}

/** Shared fetch + error handling for calls against the prediction service. Rejects with a descriptive error on network failure or a non-2xx response. */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getBaseUrl();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, init);
  } catch (exception) {
    throw new Error(
      `Could not reach the prediction service at ${baseUrl} (${
        exception instanceof Error ? exception.message : String(exception)
      }).`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Prediction service returned ${response.status} ${response.statusText}${
        body.length > 0 ? `: ${body}` : ""
      }`,
    );
  }
  return (await response.json()) as T;
}

/** POST to the service's /predict endpoint. */
export async function requestPredictions(
  payload: PredictRequestPayload,
): Promise<PredictResponsePayload> {
  return fetchJson<PredictResponsePayload>("/predict", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** GET the list of reference datasets (developmental stages) the service can match against. */
export async function getReferenceDatasets(): Promise<string[]> {
  return fetchJson<string[]>("/reference_datasets");
}

/** GET the neuron names known to a given reference dataset, e.g. for validating/autocompleting confirmed names. */
export async function getReferenceDatasetNeurons(
  referenceDataset: string,
): Promise<ReferenceDatasetNeuronsPayload> {
  return fetchJson<ReferenceDatasetNeuronsPayload>(
    `/reference_datasets/${encodeURIComponent(referenceDataset)}/neurons`,
  );
}

/** URL for the service's neuron diagram image (JPEG), suitable for direct use as an <img> src. 404s if no diagram is available for that name. */
export function getNeuronDiagramUrl(neuronName: string): string {
  return `${getBaseUrl()}/neuron_diagrams/${encodeURIComponent(neuronName)}`;
}
