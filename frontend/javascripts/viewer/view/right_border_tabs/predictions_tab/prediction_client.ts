/*
 * Client for the standalone `tools/neuron_identity_service`, which predicts
 * identities for a whole contactome in a single call. The types below mirror
 * that service's `app/schemas.py` field-for-field — read that file directly
 * if this drifts, rather than trusting this comment.
 *
 * Plain `fetch` is used deliberately instead of WK's `Request` helper
 * (libs/request.ts): that helper is geared toward WK's own authenticated
 * endpoints, and this service takes no WK token by design.
 */
import type { IdentityCandidate } from "viewer/view/right_border_tabs/neuron_identity_tab/neuron_identity_metadata";

export type PredictionServiceInputSegment = {
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
  segments: PredictionServiceInputSegment[];
  contact_edges: PredictionServiceContactEdge[];
  exclude_assigned_names?: boolean;
  max_candidates?: number;
  model?: string;
};

export type SegmentPredictionPayload = {
  segment_id: number;
  candidates: IdentityCandidate[];
};

export type PredictResponsePayload = {
  model: string;
  predictions: SegmentPredictionPayload[];
};

const DEFAULT_BASE_URL = "http://localhost:8010";

function getBaseUrl(): string {
  return import.meta.env.VITE_PREDICTION_SERVICE_URL ?? DEFAULT_BASE_URL;
}

/** POST to the service's /predict endpoint. Rejects with a descriptive error on network failure or a non-2xx response. */
export async function requestPredictions(
  payload: PredictRequestPayload,
): Promise<PredictResponsePayload> {
  const baseUrl = getBaseUrl();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
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
  return (await response.json()) as PredictResponsePayload;
}
