/*
 * Parser for the "contact profile" file dropped in the Predictions panel: a
 * weighted contact graph between segments (edge = how much two neurons touch),
 * used as a future input feature for the predictor.
 *
 * Column names ("neuron1"/"neuron2"/"contact_strength", case-insensitive)
 * match the contactome_matching package's own CSV convention (see its
 * Contactome.from_csv / the bundled Witvliet reference contactomes), so the
 * same file can be fed to either side without renaming columns. Columns are
 * looked up BY NAME rather than assumed to be at a fixed position — an
 * earlier positional-only version silently misread files that had e.g. a
 * leading pandas index column, shifting every column by one. The weight
 * column name is required to be exactly "contact_strength" rather than
 * "whichever column is left over" — that looser rule would silently read a
 * stray blank/index column as the weight instead of rejecting the file.
 */

export type ContactEdge = {
  neuronA: number;
  neuronB: number;
  weight: number;
};

export type ContactProfileParseResult = {
  edges: ContactEdge[];
  skippedRowCount: number;
};

function detectDelimiter(headerLine: string): string {
  return headerLine.includes("\t") ? "\t" : ",";
}

/**
 * Parse a CSV/TSV contact profile. The header row must contain "neuron1",
 * "neuron2", and "contact_strength" columns (case-insensitive). Data rows
 * are read by those column positions, not by position 0/1/2 — rows that
 * don't fit are counted as skipped rather than aborting the whole file.
 */
export function parseContactProfile(fileContents: string): ContactProfileParseResult {
  const lines = fileContents.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
  const edges: ContactEdge[] = [];
  let skippedRowCount = 0;

  if (lines.length === 0) {
    return { edges, skippedRowCount };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headerColumns = lines[0].split(delimiter).map((column) => column.trim().toLowerCase());
  const neuronAIndex = headerColumns.indexOf("neuron1");
  const neuronBIndex = headerColumns.indexOf("neuron2");
  const weightIndex = headerColumns.indexOf("contact_strength");
  if (neuronAIndex === -1 || neuronBIndex === -1 || weightIndex === -1) {
    throw new Error(
      'Contact profile header must contain "neuron1", "neuron2", and "contact_strength" columns.',
    );
  }
  const requiredColumnCount = Math.max(neuronAIndex, neuronBIndex, weightIndex) + 1;

  for (const line of lines.slice(1)) {
    const columns = line.split(delimiter).map((column) => column.trim());
    if (columns.length < requiredColumnCount) {
      skippedRowCount += 1;
      continue;
    }
    const neuronA = Number.parseInt(columns[neuronAIndex], 10);
    const neuronB = Number.parseInt(columns[neuronBIndex], 10);
    const weight = Number.parseFloat(columns[weightIndex]);
    if (!Number.isFinite(neuronA) || !Number.isFinite(neuronB) || !Number.isFinite(weight)) {
      skippedRowCount += 1;
      continue;
    }
    edges.push({ neuronA, neuronB, weight });
  }

  return { edges, skippedRowCount };
}

/** Distinct segment IDs referenced across all edges. */
export function getDistinctNeuronIds(edges: ContactEdge[]): number[] {
  const ids = new Set<number>();
  for (const edge of edges) {
    ids.add(edge.neuronA);
    ids.add(edge.neuronB);
  }
  return Array.from(ids);
}

/** Count of distinct segment IDs referenced across all edges. */
export function countDistinctNeurons(edges: ContactEdge[]): number {
  return getDistinctNeuronIds(edges).length;
}
// timestamp Tue Sep 29 10:07:41 CDT 2026
