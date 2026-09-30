/*
 * Neuron-identity data is stored inside the existing per-segment `metadata`
 * list (MetadataEntryProto[]) under a reserved `identity.*` key namespace, so
 * no backend schema change is required. This module is the single place
 * that knows that encoding; the rest of the feature works with the typed
 * `SegmentIdentity` view-model returned by `getSegmentIdentity`.
 *
 * Model: candidates are keyed by (segment, name), not by segment alone. A
 * segment can have candidate names from multiple independent sources (e.g.
 * a live prediction run and a separately-uploaded offline-prediction CSV),
 * each with its own score for that name; a later run merges into existing
 * per-name scores by source rather than replacing them.
 */
import type { MetadataEntryProto } from "types/api_types";
import type { Segment } from "viewer/store";

export const IdentityMetadataKeys = {
  candidates: "identity.candidatesJson", // stringValue: JSON-encoded CandidateScores[]
  confirmed: "identity.confirmed", // stringValue: user-chosen name
  predictedAt: "identity.predictedAt", // numberValue: timestamp (ms) of the most recent write
} as const;

export type CandidateScores = {
  name: string;
  /** Score per source, e.g. { prediction: 0.82, offline_csv: 0.91 }. */
  scoresBySource: Record<string, number>;
};

export type IdentityStatus = "predicted" | "confirmed" | "none";

export type SegmentIdentity = {
  candidates: CandidateScores[];
  confirmed: string | null;
  predictedAt: number | null;
};

function findEntry(metadata: MetadataEntryProto[], key: string): MetadataEntryProto | undefined {
  return metadata.find((entry) => entry.key === key);
}

function parseCandidates(encoded: string | undefined): CandidateScores[] {
  if (encoded == null) {
    return [];
  }
  try {
    const parsed = JSON.parse(encoded);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (candidate): candidate is CandidateScores =>
        typeof candidate?.name === "string" && typeof candidate?.scoresBySource === "object",
    );
  } catch (_exception) {
    return [];
  }
}

/** Derive the typed identity view-model from a segment's raw metadata. */
export function getSegmentIdentity(segment: Segment): SegmentIdentity {
  const metadata = segment.metadata ?? [];
  const candidates = parseCandidates(
    findEntry(metadata, IdentityMetadataKeys.candidates)?.stringValue,
  );
  return {
    candidates,
    confirmed: findEntry(metadata, IdentityMetadataKeys.confirmed)?.stringValue ?? null,
    predictedAt: findEntry(metadata, IdentityMetadataKeys.predictedAt)?.numberValue ?? null,
  };
}

/** Overall status for a segment, derived from its identity (used for filtering/tagging). */
export function getIdentityStatus(identity: SegmentIdentity): IdentityStatus {
  if (identity.confirmed != null) {
    return "confirmed";
  }
  return identity.candidates.length > 0 ? "predicted" : "none";
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

/**
 * Return a new metadata array with the given name marked as confirmed. The
 * caller is expected to also set the segment's canonical `name` to `name`.
 */
export function withConfirmedIdentity(
  metadata: MetadataEntryProto[],
  name: string,
): MetadataEntryProto[] {
  return upsertEntry(metadata, { key: IdentityMetadataKeys.confirmed, stringValue: name });
}

/** Clear the confirmed decision (keeps candidates as-is). */
export function withUnconfirmedIdentity(metadata: MetadataEntryProto[]): MetadataEntryProto[] {
  return metadata.filter((entry) => entry.key !== IdentityMetadataKeys.confirmed);
}

/**
 * Merge a fresh batch of (name, score) candidates from one source into a
 * segment's existing candidate list. Existing scores from OTHER sources are
 * preserved; this source's score for each name is overwritten with the new
 * value (a re-run from the same source supersedes its own earlier score).
 */
export function withMergedCandidates(
  metadata: MetadataEntryProto[],
  source: string,
  newCandidates: { name: string; score: number }[],
  predictedAt: number,
): MetadataEntryProto[] {
  const existing = parseCandidates(
    findEntry(metadata, IdentityMetadataKeys.candidates)?.stringValue,
  );
  const byName = new Map(existing.map((candidate) => [candidate.name, candidate]));
  for (const { name, score } of newCandidates) {
    const current = byName.get(name) ?? { name, scoresBySource: {} };
    byName.set(name, { name, scoresBySource: { ...current.scoresBySource, [source]: score } });
  }
  let next = upsertEntry(metadata, {
    key: IdentityMetadataKeys.candidates,
    stringValue: JSON.stringify(Array.from(byName.values())),
  });
  next = upsertEntry(next, { key: IdentityMetadataKeys.predictedAt, numberValue: predictedAt });
  return next;
}
