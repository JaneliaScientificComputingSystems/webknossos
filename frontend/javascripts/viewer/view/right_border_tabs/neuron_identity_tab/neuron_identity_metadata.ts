/*
 * Neuron-identity data is stored inside the existing per-segment `metadata`
 * list (MetadataEntryProto[]) under a reserved `identity.*` key namespace, so no
 * backend schema change is required. This module is the single place that knows
 * that encoding; the rest of the feature works with the typed `SegmentIdentity`
 * view-model returned by `getSegmentIdentity`.
 *
 * See NEURON_IDENTITY_PANEL_PLAN.md (§3) for the convention.
 */
import type { MetadataEntryProto } from "types/api_types";
import type { Segment } from "viewer/store";

export const IdentityMetadataKeys = {
  candidates: "identity.candidates", // stringListValue, ranked, each "NAME|SCORE"
  status: "identity.status", // stringValue: predicted | confirmed | rejected
  confirmed: "identity.confirmed", // stringValue: user-chosen name
  model: "identity.model", // stringValue: model id/version (provenance)
  predictedAt: "identity.predictedAt", // numberValue: timestamp (ms)
} as const;

export type IdentityStatus = "predicted" | "confirmed" | "rejected" | "none";

export type IdentityCandidate = {
  name: string;
  score: number;
};

export type SegmentIdentity = {
  candidates: IdentityCandidate[];
  status: IdentityStatus;
  confirmed: string | null;
  model: string | null;
  predictedAt: number | null;
};

const CANDIDATE_SEPARATOR = "|";

function encodeCandidate({ name, score }: IdentityCandidate): string {
  return `${name}${CANDIDATE_SEPARATOR}${score}`;
}

function decodeCandidate(encoded: string): IdentityCandidate | null {
  // Neuron names never contain "|"; split on the last separator to be safe.
  const separatorIndex = encoded.lastIndexOf(CANDIDATE_SEPARATOR);
  if (separatorIndex < 0) {
    // No score encoded — treat the whole string as a name with unknown score.
    return { name: encoded, score: Number.NaN };
  }
  const name = encoded.slice(0, separatorIndex);
  const score = Number.parseFloat(encoded.slice(separatorIndex + 1));
  if (name.length === 0) {
    return null;
  }
  return { name, score };
}

function findEntry(metadata: MetadataEntryProto[], key: string): MetadataEntryProto | undefined {
  return metadata.find((entry) => entry.key === key);
}

/** Derive the typed identity view-model from a segment's raw metadata. */
export function getSegmentIdentity(segment: Segment): SegmentIdentity {
  const metadata = segment.metadata ?? [];

  const candidateEntry = findEntry(metadata, IdentityMetadataKeys.candidates);
  const candidates =
    candidateEntry?.stringListValue
      ?.map(decodeCandidate)
      .filter((candidate): candidate is IdentityCandidate => candidate != null) ?? [];

  const statusValue = findEntry(metadata, IdentityMetadataKeys.status)?.stringValue;
  const status: IdentityStatus =
    statusValue === "predicted" || statusValue === "confirmed" || statusValue === "rejected"
      ? statusValue
      : candidates.length > 0
        ? "predicted"
        : "none";

  return {
    candidates,
    status,
    confirmed: findEntry(metadata, IdentityMetadataKeys.confirmed)?.stringValue ?? null,
    model: findEntry(metadata, IdentityMetadataKeys.model)?.stringValue ?? null,
    predictedAt: findEntry(metadata, IdentityMetadataKeys.predictedAt)?.numberValue ?? null,
  };
}

/** Whether a segment carries any identity metadata at all. */
export function hasIdentityMetadata(segment: Segment): boolean {
  const identityKeys = Object.values(IdentityMetadataKeys) as string[];
  return (segment.metadata ?? []).some((entry) => identityKeys.includes(entry.key));
}

function upsertEntry(
  metadata: MetadataEntryProto[],
  entry: MetadataEntryProto,
): MetadataEntryProto[] {
  const withoutKey = metadata.filter((existing) => existing.key !== entry.key);
  return [...withoutKey, entry];
}

function removeEntry(metadata: MetadataEntryProto[], key: string): MetadataEntryProto[] {
  return metadata.filter((existing) => existing.key !== key);
}

/**
 * Return a new metadata array with the identity marked as confirmed to `name`.
 * The caller is expected to also set the segment's canonical `name` to `name`.
 */
export function withConfirmedIdentity(
  metadata: MetadataEntryProto[],
  name: string,
): MetadataEntryProto[] {
  let next = upsertEntry(metadata, {
    key: IdentityMetadataKeys.status,
    stringValue: "confirmed",
  });
  next = upsertEntry(next, { key: IdentityMetadataKeys.confirmed, stringValue: name });
  return next;
}

/** Return a new metadata array with the identity marked as rejected. */
export function withRejectedIdentity(metadata: MetadataEntryProto[]): MetadataEntryProto[] {
  const next = upsertEntry(metadata, {
    key: IdentityMetadataKeys.status,
    stringValue: "rejected",
  });
  return removeEntry(next, IdentityMetadataKeys.confirmed);
}

/**
 * Reset the proofreading decision back to "predicted" (keeping the candidate
 * list), or "none" if there are no candidates.
 */
export function withResetIdentityStatus(metadata: MetadataEntryProto[]): MetadataEntryProto[] {
  return removeEntry(
    removeEntry(metadata, IdentityMetadataKeys.status),
    IdentityMetadataKeys.confirmed,
  );
}

/**
 * Write a fresh set of ranked candidates onto a segment's metadata. Used later
 * by the prediction-ingestion step; kept here so the encoding lives in one place.
 */
export function withPredictedCandidates(
  metadata: MetadataEntryProto[],
  candidates: IdentityCandidate[],
  model: string,
  predictedAt: number,
): MetadataEntryProto[] {
  let next = upsertEntry(metadata, {
    key: IdentityMetadataKeys.candidates,
    stringListValue: candidates.map(encodeCandidate),
  });
  next = upsertEntry(next, { key: IdentityMetadataKeys.model, stringValue: model });
  next = upsertEntry(next, { key: IdentityMetadataKeys.predictedAt, numberValue: predictedAt });
  // A new prediction supersedes any previous decision unless already confirmed.
  const status = findEntry(next, IdentityMetadataKeys.status)?.stringValue;
  if (status !== "confirmed") {
    next = upsertEntry(next, { key: IdentityMetadataKeys.status, stringValue: "predicted" });
  }
  return next;
}
