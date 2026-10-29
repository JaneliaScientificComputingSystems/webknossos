/*
 * Client for the standalone nuclear-position-based prediction service (see
 * celegans-cell-id/service), which predicts cell identities from nuclear
 * positions in a single call. The types below mirror that service's
 * `app/schemas.py` field-for-field — read that file directly if this
 * drifts, rather than trusting this comment.
 *
 * Unlike the contactome service, this predicts against exactly ONE
 * registered reference atlas (embryo + timepoint) per call, and takes each
 * tree's position directly rather than a contact graph.
 *
 * Plain `fetch` is used deliberately instead of WK's `Request` helper
 * (libs/request.ts): that helper is geared toward WK's own authenticated
 * endpoints, and this service takes no WK token by design.
 */
export type NuclearInputNode = {
  id: number;
  position: [number, number, number];
  name?: string | null;
  is_confirmed?: boolean;
};

export type NuclearPredictRequestPayload = {
  nodes: NuclearInputNode[];
  embryo: string;
  timepoint: number;
  exclude_assigned_names?: boolean;
  n_trials?: number;
};

export type NuclearCandidate = {
  name: string;
  score: number;
};

export type NuclearNodePredictionPayload = {
  node_id: number;
  candidates: NuclearCandidate[];
};

export type NuclearPredictResponsePayload = {
  embryo: string;
  timepoint: number;
  predictions: NuclearNodePredictionPayload[];
};

export type RegisteredAtlas = {
  embryo: string;
  timepoint: number;
};

const DEFAULT_BASE_URL = "http://localhost:8011";

function getBaseUrl(): string {
  return import.meta.env.VITE_NUCLEAR_PREDICTION_SERVICE_URL ?? DEFAULT_BASE_URL;
}

/** Shared fetch + error handling for calls against the nuclear prediction service. Rejects with a descriptive error on network failure or a non-2xx response. */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getBaseUrl();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, init);
  } catch (exception) {
    throw new Error(
      `Could not reach the nuclear prediction service at ${baseUrl} (${
        exception instanceof Error ? exception.message : String(exception)
      }).`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Nuclear prediction service returned ${response.status} ${response.statusText}${
        body.length > 0 ? `: ${body}` : ""
      }`,
    );
  }
  return (await response.json()) as T;
}

/** POST to the service's /predict endpoint. */
export async function requestNuclearPredictions(
  payload: NuclearPredictRequestPayload,
): Promise<NuclearPredictResponsePayload> {
  return fetchJson<NuclearPredictResponsePayload>("/predict", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** GET the list of embryo/timepoint reference atlases currently registered on the service. */
export async function getRegisteredAtlases(): Promise<RegisteredAtlas[]> {
  return fetchJson<RegisteredAtlas[]>("/atlases");
}
