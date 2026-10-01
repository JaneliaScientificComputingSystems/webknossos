/*
 * Persists the ID-prediction feature's config (contact profile, ignored
 * names) into the annotation's own `description` field — the only
 * general-purpose, frontend-writable, per-annotation text field this fork of
 * webknossos exposes (no per-annotation key-value metadata list exists,
 * unlike the per-segment `metadata: MetadataEntryProto[]` this feature
 * already uses elsewhere). That field is also a human-facing free-text box
 * in the Info tab, so this config is appended after a fenced marker rather
 * than overwriting the field outright — anything the user or dataset owner
 * wrote above the marker survives every read/write round-trip untouched.
 */
import type { ContactEdge } from "viewer/view/right_border_tabs/predictions_tab/contact_profile";

const CONFIG_MARKER = "<!-- wk-identity-prediction-config: do not edit below this line -->";

export type PersistedPredictionConfig = {
  contactEdges: ContactEdge[];
  contactFileName: string | null;
  /** ms since epoch, set when the contact profile was uploaded — null if contactFileName is null. */
  contactUploadedAt: number | null;
  ignoredNames: string[];
  /** Names confirmed at the moment of the most recent successful Run — null if no Run has completed yet. Serialized as an array (JSON has no Set type); callers convert to/from Set at the boundary. */
  lastRunConfirmedNames: string[] | null;
};

/** Strips the fenced config block (if any) from a saved description, returning just the human-written part. */
export function stripConfigFromDescription(description: string): string {
  const markerIndex = description.indexOf(CONFIG_MARKER);
  if (markerIndex === -1) {
    return description;
  }
  return description.slice(0, markerIndex).trimEnd();
}

/** Parses the fenced config block out of a saved description, if present and well-formed. Returns null otherwise (nothing saved yet, or the JSON is corrupt). */
export function parseConfigFromDescription(description: string): PersistedPredictionConfig | null {
  const markerIndex = description.indexOf(CONFIG_MARKER);
  if (markerIndex === -1) {
    return null;
  }
  const jsonText = description.slice(markerIndex + CONFIG_MARKER.length).trim();
  try {
    const parsed = JSON.parse(jsonText);
    if (
      typeof parsed !== "object" ||
      parsed == null ||
      !Array.isArray(parsed.contactEdges) ||
      !Array.isArray(parsed.ignoredNames)
    ) {
      return null;
    }
    return {
      contactEdges: parsed.contactEdges,
      contactFileName: typeof parsed.contactFileName === "string" ? parsed.contactFileName : null,
      contactUploadedAt:
        typeof parsed.contactUploadedAt === "number" ? parsed.contactUploadedAt : null,
      ignoredNames: parsed.ignoredNames.filter(
        (name: unknown): name is string => typeof name === "string",
      ),
      lastRunConfirmedNames: Array.isArray(parsed.lastRunConfirmedNames)
        ? parsed.lastRunConfirmedNames.filter(
            (name: unknown): name is string => typeof name === "string",
          )
        : null,
    };
  } catch (_exception) {
    return null;
  }
}

/** Rebuilds a description string: the human-written part (untouched) plus a fresh fenced config block. */
export function encodeConfigIntoDescription(
  currentDescription: string,
  config: PersistedPredictionConfig,
): string {
  const humanPart = stripConfigFromDescription(currentDescription);
  const configJson = JSON.stringify(config);
  return `${humanPart}${humanPart.length > 0 ? "\n\n" : ""}${CONFIG_MARKER}\n${configJson}`;
}
