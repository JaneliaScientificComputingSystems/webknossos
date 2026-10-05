/*
 * Parser for the "Upload Offline Predictions" CSV, read entirely
 * client-side (unlike the live /predict call, there's no actual computation
 * here for a service to do — the old /offline_predictions/{id} endpoint was
 * just a text-transform, so this inlines that same by-column-name parsing
 * contact_profile.ts already does for the other CSV type).
 *
 * Two header shapes are accepted, told apart by whether a "score" column is
 * present:
 *  - scores: "seg", "neuron", "score" — externally-computed candidate
 *    confidences, one row per (segment, candidate) pair.
 *  - seeds: "seg", "neuron" only — ground-truth assignments. Written as a
 *    candidate with score 1.0 (so they still show up, sortable, alongside
 *    other sources) AND auto-confirmed, since a seed is a decision, not a
 *    guess.
 */
import type { ServiceCandidate } from "viewer/view/right_border_tabs/predictions_tab/prediction_client";

export type SegmentPrediction = {
  segment_id: number;
  candidates: ServiceCandidate[];
};

export type OfflinePredictionsParseResult = {
  predictions: SegmentPrediction[];
  /** true if this file had no "score" column (seg/neuron only) — candidates are synthesized at 1.0 and should be auto-confirmed. */
  isSeeds: boolean;
  skippedRowCount: number;
};

function detectDelimiter(headerLine: string): string {
  return headerLine.includes("\t") ? "\t" : ",";
}

const SEED_SCORE = 1;

export function parseOfflinePredictions(fileContents: string): OfflinePredictionsParseResult {
  const lines = fileContents.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { predictions: [], isSeeds: false, skippedRowCount: 0 };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headerColumns = lines[0].split(delimiter).map((column) => column.trim().toLowerCase());
  const segmentIndex = headerColumns.indexOf("seg");
  const neuronIndex = headerColumns.indexOf("neuron");
  const scoreIndex = headerColumns.indexOf("score");
  if (segmentIndex === -1 || neuronIndex === -1) {
    throw new Error('Offline predictions header must contain "seg" and "neuron" columns.');
  }
  const isSeeds = scoreIndex === -1;
  const requiredColumnCount = Math.max(segmentIndex, neuronIndex, scoreIndex) + 1;

  const candidatesBySegmentId = new Map<number, ServiceCandidate[]>();
  const order: number[] = [];
  let skippedRowCount = 0;

  for (const line of lines.slice(1)) {
    const columns = line.split(delimiter).map((column) => column.trim());
    if (columns.length < requiredColumnCount) {
      skippedRowCount += 1;
      continue;
    }
    const segmentId = Number.parseInt(columns[segmentIndex], 10);
    const name = columns[neuronIndex];
    const score = isSeeds ? SEED_SCORE : Number.parseFloat(columns[scoreIndex]);
    if (!Number.isFinite(segmentId) || name.length === 0 || !Number.isFinite(score)) {
      skippedRowCount += 1;
      continue;
    }
    if (!candidatesBySegmentId.has(segmentId)) {
      candidatesBySegmentId.set(segmentId, []);
      order.push(segmentId);
    }
    candidatesBySegmentId.get(segmentId)?.push({ name, score });
  }

  const predictions = order.map((segmentId) => ({
    segment_id: segmentId,
    candidates: candidatesBySegmentId.get(segmentId) ?? [],
  }));
  return { predictions, isSeeds, skippedRowCount };
}
