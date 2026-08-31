/** Client-side parse of production file-slot names: `CODE [xQTY] - M.R.m - PRINTER`. */

const PRODUCTION_FILENAME_RE =
  /^([A-Z]+)(?:\s*x(\d+))?\s*-\s*(\d+)\.(\d+)\.(\d+)\s*-\s*(.+)$/i;

const STRIP_EXTENSIONS = ['.gcode.3mf', '.3mf', '.gcode'] as const;

const PRODUCTION_PRINTER_COMPACT: Record<string, string> = {
  A1M: 'A1M',
  A1MINI: 'A1M',
  BAMBULABA1M: 'A1M',
  BAMBULABA1MINI: 'A1M',
  X1C: 'X1C',
  X1CARBON: 'X1C',
  BAMBULABX1CARBON: 'X1C',
  BAMBULABX1C: 'X1C',
  A1: 'A1',
  BAMBULABA1: 'A1',
  H2D: 'H2D',
  BAMBULABH2D: 'H2D',
  H2S: 'H2S',
  BAMBULABH2S: 'H2S',
};

const DISPLAY_TO_PRODUCTION: Record<string, string> = {
  'A1 Mini': 'A1M',
};

function compactPrinter(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s\-_]/g, '');
}

export function normalizeProductionPrinter(raw: string | null | undefined): string {
  if (!raw) return '';
  const text = String(raw).trim();
  if (!text) return '';
  const compact = compactPrinter(text);
  if (compact in PRODUCTION_PRINTER_COMPACT) {
    return PRODUCTION_PRINTER_COMPACT[compact];
  }
  if (text in DISPLAY_TO_PRODUCTION) {
    return DISPLAY_TO_PRODUCTION[text];
  }
  return PRODUCTION_PRINTER_COMPACT[compactPrinter(text)] ?? text;
}

/** True when two model strings are the same printer (A1M ↔ A1 Mini, X1 Carbon ↔ X1C). */
export function printerModelsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const na = normalizeProductionPrinter(a);
  const nb = normalizeProductionPrinter(b);
  if (!na || !nb) return false;
  return compactPrinter(na) === compactPrinter(nb);
}

/** Prefer slice metadata; fall back to a production filename's printer suffix. */
export function resolvePrintTargetModel(
  slicedForModel: string | null | undefined,
  filename: string | null | undefined,
): string | null {
  const sliced = slicedForModel?.trim();
  if (sliced) return sliced;
  return parseProductionFilename(filename || '')?.printer || null;
}

export interface ParsedProductionFilename {
  code: string;
  quantity: number;
  major: number;
  revision: number;
  minor: number;
  printer: string;
  version: string;
}

function stripProductionExtension(name: string): string {
  const lower = name.toLowerCase();
  for (const ext of STRIP_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return name.slice(0, -ext.length);
    }
  }
  return name;
}

export function productionFileExtension(name: string): string {
  const basename = String(name).split(/[/\\]/).pop() ?? String(name);
  const lower = basename.toLowerCase();
  for (const ext of STRIP_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  const dot = basename.lastIndexOf('.');
  return dot >= 0 ? basename.slice(dot) : '';
}

export function formatProductionFilename(
  code: string,
  quantity: number,
  major: number,
  revision: number,
  minor: number,
  printer: string,
): string {
  const printerCode = normalizeProductionPrinter(printer) || printer.trim();
  const qtyPart = quantity !== 1 ? ` x${quantity}` : '';
  return `${code.trim().toUpperCase()}${qtyPart} - ${major}.${revision}.${minor} - ${printerCode}`;
}

export function storedProductionFilename(
  originalName: string,
  code: string,
  quantity: number,
  major: number,
  revision: number,
  minor: number,
  printer: string,
): string {
  return `${formatProductionFilename(code, quantity, major, revision, minor, printer)}${productionFileExtension(originalName)}`;
}

export function parseProductionFilename(name: string): ParsedProductionFilename | null {
  if (!name || !String(name).trim()) return null;
  const basename = String(name).split(/[/\\]/).pop() ?? String(name);
  const stem = stripProductionExtension(basename).trim();
  const match = PRODUCTION_FILENAME_RE.exec(stem);
  if (!match) return null;
  const printer = normalizeProductionPrinter(match[6]);
  if (!printer) return null;
  const major = Number(match[3]);
  const revision = Number(match[4]);
  const minor = Number(match[5]);
  return {
    code: match[1].toUpperCase(),
    quantity: match[2] ? Number(match[2]) : 1,
    major,
    revision,
    minor,
    printer,
    version: `${major}.${revision}.${minor}`,
  };
}
