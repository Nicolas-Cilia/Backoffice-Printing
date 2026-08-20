import type { ProductionParameterDiff } from '../../api/client';

/**
 * Helpers for production parameter-mismatch notes.
 * Live here so ProductionParameterDiffTable.tsx only exports React components
 * (`react-refresh/only-export-components`).
 */

export function collectParameterNotes(
  rows: ProductionParameterDiff[],
  notes: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.match) continue;
    const text = (notes[row.key] ?? '').trim();
    if (text) out[row.key] = text;
  }
  return out;
}

export function mismatchNotesComplete(
  rows: ProductionParameterDiff[],
  notes: Record<string, string>,
): boolean {
  return rows.every((row) => row.match || (notes[row.key] ?? '').trim().length > 0);
}
