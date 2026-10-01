/*
 * Neuron-identity data is stored inside the existing per-segment `metadata`
 * list (MetadataEntryProto[]) under a reserved `identity.*` key namespace, so
 * no backend schema change is required. This module is the single place
 * that knows that encoding; the rest of the feature works with the typed
 * `SegmentIdentity` view-model returned by `getSegmentIdentity`.
 *
 * Storage: each source (e.g. a live prediction run against one reference
 * dataset, or a separately-uploaded offline-prediction CSV) gets its OWN
 * metadata entry — `identity.source.<source>` — holding just that source's
 * candidates as a JSON array of [name, score] tuples (not {name, score}
 * objects — more compact), sorted by score descending. This is what shows up
 * in WK's native per-segment metadata table (Segments panel), so keeping one
 * entry per source, pre-sorted and tuple-encoded, makes the raw value
 * directly readable there instead of one big merged, unsorted, verbose JSON
 * blob. The `source.` segment disambiguates a source entry from a static key
 * like `identity.predictedAt` — without it, a source literally named
 * "predictedAt" would be indistinguishable from the static key, and any new
 * static key added later risks colliding with an existing source name. A
 * later run from the same source overwrites only its own entry; other
 * sources' entries are untouched.
 */
import type { MetadataEntryProto } from "types/api_types";
import type { Segment } from "viewer/store";

const CANDIDATES_KEY_PREFIX = "identity.source.";

export const IdentityMetadataKeys = {
  confirmed: "identity.confirmed", // stringValue: user-chosen name
  predictedAt: "identity.predictedAt", // numberValue: timestamp (ms) of the most recent write
  ignored: "identity.ignored", // boolValue: true if marked "not a neuron" / excluded from matching
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
  /** Marked "not a neuron" — excluded from live Run's prediction targets and hidden from Proofread IDs by default. */
  ignored: boolean;
};

function findEntry(metadata: MetadataEntryProto[], key: string): MetadataEntryProto | undefined {
  return metadata.find((entry) => entry.key === key);
}

function candidatesKeyFor(source: string): string {
  return `${CANDIDATES_KEY_PREFIX}${source}`;
}

const STATIC_KEYS = Object.values(IdentityMetadataKeys) as string[];

function sourceFromCandidatesKey(key: string): string | null {
  if (STATIC_KEYS.includes(key) || !key.startsWith(CANDIDATES_KEY_PREFIX)) {
    return null;
  }
  return key.slice(CANDIDATES_KEY_PREFIX.length);
}

/** Each candidate is stored as a [name, score] tuple (a plain 2-element JSON array), not a {name, score} object. */
function parseSourceCandidates(encoded: string | undefined): { name: string; score: number }[] {
  if (encoded == null) {
    return [];
  }
  try {
    const parsed = JSON.parse(encoded);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (tuple): tuple is [string, number] =>
          Array.isArray(tuple) &&
          tuple.length === 2 &&
          typeof tuple[0] === "string" &&
          typeof tuple[1] === "number",
      )
      .map(([name, score]) => ({ name, score }));
  } catch (_exception) {
    return [];
  }
}

/** Derive the typed identity view-model from a segment's raw metadata. */
export function getSegmentIdentity(segment: Segment): SegmentIdentity {
  const metadata = segment.metadata ?? [];
  const byName = new Map<string, CandidateScores>();
  for (const entry of metadata) {
    const source = sourceFromCandidatesKey(entry.key);
    if (source == null) {
      continue;
    }
    for (const { name, score } of parseSourceCandidates(entry.stringValue)) {
      const current = byName.get(name) ?? { name, scoresBySource: {} };
      current.scoresBySource[source] = score;
      byName.set(name, current);
    }
  }
  return {
    candidates: Array.from(byName.values()),
    confirmed: findEntry(metadata, IdentityMetadataKeys.confirmed)?.stringValue ?? null,
    predictedAt: findEntry(metadata, IdentityMetadataKeys.predictedAt)?.numberValue ?? null,
    ignored: findEntry(metadata, IdentityMetadataKeys.ignored)?.boolValue ?? false,
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
  const staticKeys = Object.values(IdentityMetadataKeys) as string[];
  return (segment.metadata ?? []).some(
    (entry) => staticKeys.includes(entry.key) || sourceFromCandidatesKey(entry.key) != null,
  );
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

/** Mark a segment "not a neuron" / ignored — excluded from live Run's targets and hidden by default. */
export function withIgnored(metadata: MetadataEntryProto[]): MetadataEntryProto[] {
  return upsertEntry(metadata, { key: IdentityMetadataKeys.ignored, boolValue: true });
}

/** Clear the ignored flag. */
export function withUnignored(metadata: MetadataEntryProto[]): MetadataEntryProto[] {
  return metadata.filter((entry) => entry.key !== IdentityMetadataKeys.ignored);
}

/**
 * Overwrite this source's own candidate entry with a fresh batch of (name,
 * score) pairs, sorted by score descending. Other sources' entries are left
 * untouched — a re-run from the same source supersedes only its own earlier
 * entry, never another source's.
 */
export function withMergedCandidates(
  metadata: MetadataEntryProto[],
  source: string,
  newCandidates: { name: string; score: number }[],
  predictedAt: number,
): MetadataEntryProto[] {
  const sorted = [...newCandidates]
    .sort((a, b) => b.score - a.score)
    .map(({ name, score }): [string, number] => [name, score]);
  let next = upsertEntry(metadata, {
    key: candidatesKeyFor(source),
    stringValue: JSON.stringify(sorted),
  });
  next = upsertEntry(next, { key: IdentityMetadataKeys.predictedAt, numberValue: predictedAt });
  return next;
}
