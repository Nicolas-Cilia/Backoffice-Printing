/** Format locked production print settings for the folder-view spec summary. */

export const SPEC_KEY_ORDER = [
  'curr_bed_type',
  'layer_height',
  'initial_layer_line_width',
  'sparse_infill_density',
  'sparse_infill_pattern',
  'wall_loops',
  'brim_type',
  'brim_width',
  'brim_object_gap',
  'fuzzy_skin',
  'fuzzy_skin_thickness',
  'fuzzy_skin_point_distance',
  'enable_support',
  'support_type',
  'support_style',
  'enable_prime_tower',
  'seam_position',
  'nozzles_used',
] as const;

const HIDDEN_KEYS = new Set(['_multi_color']);

/** Folded into the Supports row; not listed separately in the specs panel. */
const FOLDED_SUPPORT_KEYS = new Set(['support_type', 'support_style']);

const MM_KEYS = new Set([
  'layer_height',
  'initial_layer_line_width',
  'brim_width',
  'brim_object_gap',
  'fuzzy_skin_thickness',
  'fuzzy_skin_point_distance',
]);

const PERCENT_KEYS = new Set(['sparse_infill_density']);

/** Bambu/Orca enum tokens → i18n leaf under specs.infillPatterns. Zigzag is legacy Prusa for rectilinear. */
const INFILL_PATTERN_ALIASES: Record<string, string> = {
  concentric: 'concentric',
  rectilinear: 'rectilinear',
  zigzag: 'rectilinear',
  monotonic: 'monotonic',
  monotonicline: 'monotonicLine',
  alignedrectilinear: 'alignedRectilinear',
  hilbertcurve: 'hilbertCurve',
  archimedeanchords: 'archimedeanChords',
  octagramspiral: 'octagramSpiral',
};

const BOOL_KEYS = new Set(['enable_support', 'enable_prime_tower']);

const LABEL_KEYS: Record<string, string> = {
  curr_bed_type: 'fileManager.production.specs.bed',
  layer_height: 'fileManager.production.specs.layerHeight',
  initial_layer_line_width: 'fileManager.production.specs.initialLayerLineWidth',
  sparse_infill_density: 'fileManager.production.specs.infillDensity',
  sparse_infill_pattern: 'fileManager.production.specs.infillPattern',
  wall_loops: 'fileManager.production.specs.wallLoops',
  brim_type: 'fileManager.production.specs.brimType',
  brim_width: 'fileManager.production.specs.brimWidth',
  brim_object_gap: 'fileManager.production.specs.brimObjectGap',
  fuzzy_skin: 'fileManager.production.specs.fuzzySkin',
  fuzzy_skin_thickness: 'fileManager.production.specs.fuzzySkinThickness',
  fuzzy_skin_point_distance: 'fileManager.production.specs.fuzzySkinPointDistance',
  enable_support: 'fileManager.production.specs.enableSupport',
  support_type: 'fileManager.production.specs.supportType',
  support_style: 'fileManager.production.specs.supportStyle',
  enable_prime_tower: 'fileManager.production.specs.enablePrimeTower',
  seam_position: 'fileManager.production.specs.seamPosition',
  nozzles_used: 'fileManager.production.specs.nozzlesUsed',
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function mergeProductionSpecs(
  locked: Record<string, unknown> | null | undefined,
  overrides: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(locked ?? {}) };
  if (overrides) Object.assign(merged, overrides);
  for (const key of HIDDEN_KEYS) delete merged[key];
  return merged;
}

export function specLabelKey(key: string): string {
  return LABEL_KEYS[key] ?? '';
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    let text = value.trim();
    if (text.endsWith('%')) text = text.slice(0, -1).trim();
    else if (/mm$/i.test(text)) text = text.slice(0, -2).trim();
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(4)).toString());
}

export function isEnabledFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return text === '1' || text === 'true' || text === 'yes' || text === 'on';
  }
  if (typeof value === 'number') return value !== 0;
  return false;
}

const FUZZY_SKIN_OFF = new Set(['off', '0', 'false', 'disabled', 'disabled_fuzzy']);
const FUZZY_SKIN_ALLOW_PAINT = new Set(['none']);
const FUZZY_SKIN_PAINT = new Set(['paint', 'painted', 'selected', 'fuzzy_skin_paint', 'paint_only']);

export function isFuzzySkinPaint(value: unknown): boolean {
  const text = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return FUZZY_SKIN_PAINT.has(text);
}

export function isFuzzySkinOn(value: unknown): boolean {
  if (value == null) return false;
  const text = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return text !== '' && !FUZZY_SKIN_OFF.has(text) && !FUZZY_SKIN_ALLOW_PAINT.has(text);
}

function fuzzySkinLabel(value: unknown, t: Translate): string {
  if (isFuzzySkinPaint(value)) return t('fileManager.production.specs.fuzzySkinPainted');
  const text = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (FUZZY_SKIN_ALLOW_PAINT.has(text)) return t('fileManager.production.specs.fuzzySkinAllowPaint');
  return isFuzzySkinOn(value) ? t('fileManager.production.specs.on') : t('fileManager.production.specs.off');
}

export function isBrimOff(value: unknown): boolean {
  if (value == null) return false;
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return key === 'no_brim' || key === 'none' || key === 'off';
}

function brimLabel(value: unknown, t: Translate): string {
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (key === 'auto_brim' || key === 'auto') return t('fileManager.production.specs.brimAuto');
  if (key === 'no_brim' || key === 'none' || key === 'off') return t('fileManager.production.specs.brimNone');
  if (key === 'outer_only' || key === 'outer') return t('fileManager.production.specs.brimOuter');
  if (key === 'inner_only' || key === 'inner') return t('fileManager.production.specs.brimInner');
  if (key === 'outer_and_inner' || key === 'inner_outer' || key === 'both') {
    return t('fileManager.production.specs.brimBoth');
  }
  return String(value);
}

function nozzlesLabel(value: unknown, t: Translate): string {
  const key = String(value).trim().toLowerCase();
  if (key === 'left') return t('fileManager.production.specs.nozzlesLeft');
  if (key === 'right') return t('fileManager.production.specs.nozzlesRight');
  if (key === 'both') return t('fileManager.production.specs.nozzlesBoth');
  return String(value);
}

/** Compact alphanumeric token so "Smooth PEI" and "smooth_pei" share a map key. */
function bedTypeCompact(value: unknown): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function bedTypeLabel(value: unknown, t: Translate): string {
  const compact = bedTypeCompact(value);
  if (compact === 'texturedpeiplate' || compact === 'texturedpei' || compact === 'btpte') {
    return t('fileManager.production.specs.bedTypeTexturedPei');
  }
  if (compact === 'smoothpeiplate' || compact === 'smoothpei' || compact === 'btpeismooth') {
    return t('fileManager.production.specs.bedTypeSmoothPei');
  }
  if (compact === 'coolplate' || compact === 'pcplate' || compact === 'btpc') {
    return t('fileManager.production.specs.bedTypeCool');
  }
  if (
    compact === 'coolplatesupertack' ||
    compact === 'supertackplate' ||
    compact === 'bambucoolplatesupertack' ||
    compact === 'supertack' ||
    compact === 'btsupertack'
  ) {
    return t('fileManager.production.specs.bedTypeSuperTack');
  }
  if (compact === 'engineeringplate' || compact === 'btep') {
    return t('fileManager.production.specs.bedTypeEngineering');
  }
  if (compact === 'hightempplate' || compact === 'hotplate' || compact === 'btpei') {
    return t('fileManager.production.specs.bedTypeHighTemp');
  }
  return humanizeToken(value);
}

function humanizeToken(value: unknown): string {
  const text = String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\(\s*/g, ' (')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return String(value);
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

function isPercentLiteral(value: unknown): boolean {
  return typeof value === 'string' && value.trim().endsWith('%');
}

function isInfillPatternKey(key: string): boolean {
  return key === 'sparse_infill_pattern' || key === 'infill_pattern' || key.endsWith('_infill_pattern');
}

function infillPatternLabel(value: unknown, t: Translate): string {
  const compact = String(value).trim().toLowerCase().replace(/[\s_-]+/g, '');
  const alias = INFILL_PATTERN_ALIASES[compact];
  if (alias) return t(`fileManager.production.specs.infillPatterns.${alias}`);
  return humanizeToken(value);
}

function formatLineWidth(value: unknown, t: Translate): string {
  const number = asNumber(value);
  if (number == null) return String(value);
  if (isPercentLiteral(value)) {
    return t('fileManager.production.specs.valuePercent', { value: formatNumber(number) });
  }
  return t('fileManager.production.specs.valueMm', { value: formatNumber(number) });
}

function supportTypeLabel(value: unknown, t: Translate): string {
  const key = String(value).trim().toLowerCase().replace(/\s+/g, '');
  if (key === 'tree(auto)' || key === 'treeauto') return t('fileManager.production.specs.supportTreeAuto');
  if (key === 'tree(manual)' || key === 'treemanual') return t('fileManager.production.specs.supportTreeManual');
  if (key === 'normal(auto)' || key === 'normalauto') return t('fileManager.production.specs.supportNormalAuto');
  if (key === 'normal(manual)' || key === 'normalmanual') {
    return t('fileManager.production.specs.supportNormalManual');
  }
  return humanizeToken(value);
}

function supportStyleLabel(value: unknown, t: Translate): string {
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (key === 'tree_slim' || key === 'slim') return t('fileManager.production.specs.supportStyleSlim');
  if (key === 'tree_hybrid' || key === 'hybrid') return t('fileManager.production.specs.supportStyleHybrid');
  if (key === 'tree_strong' || key === 'strong') return t('fileManager.production.specs.supportStyleStrong');
  if (key === 'organic') return t('fileManager.production.specs.supportStyleOrganic');
  if (key === 'default') return t('fileManager.production.specs.supportStyleDefault');
  if (key === 'snug') return t('fileManager.production.specs.supportStyleSnug');
  if (key === 'grid') return t('fileManager.production.specs.supportStyleGrid');
  return humanizeToken(value);
}

export function formatSpecValue(key: string, value: unknown, t: Translate): string {
  if (value === null || value === undefined) return '—';
  if (BOOL_KEYS.has(key)) {
    return isEnabledFlag(value) ? t('fileManager.production.specs.on') : t('fileManager.production.specs.off');
  }
  if (key === 'fuzzy_skin') return fuzzySkinLabel(value, t);
  if (key === 'brim_type') return brimLabel(value, t);
  if (key === 'support_type') return supportTypeLabel(value, t);
  if (key === 'support_style') return supportStyleLabel(value, t);
  if (key === 'nozzles_used') return nozzlesLabel(value, t);
  if (key === 'curr_bed_type') return bedTypeLabel(value, t);
  if (isInfillPatternKey(key)) return infillPatternLabel(value, t);
  if (key === 'initial_layer_line_width') return formatLineWidth(value, t);
  const number = asNumber(value);
  if (number != null && MM_KEYS.has(key)) {
    return t('fileManager.production.specs.valueMm', { value: formatNumber(number) });
  }
  if (number != null && PERCENT_KEYS.has(key)) {
    return t('fileManager.production.specs.valuePercent', { value: formatNumber(number) });
  }
  if (typeof value === 'boolean') {
    return value ? t('fileManager.production.specs.on') : t('fileManager.production.specs.off');
  }
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatSupportsValue(specs: Record<string, unknown>, t: Translate): string {
  if (!isEnabledFlag(specs.enable_support)) {
    return t('fileManager.production.specs.off');
  }
  const parts: string[] = [];
  if (specs.support_type != null && String(specs.support_type).trim() !== '') {
    parts.push(formatSpecValue('support_type', specs.support_type, t));
  }
  if (specs.support_style != null && String(specs.support_style).trim() !== '') {
    parts.push(formatSpecValue('support_style', specs.support_style, t));
  }
  if (parts.length) return parts.join(' · ');
  return t('fileManager.production.specs.on');
}

function skipSpecKey(key: string, specs: Record<string, unknown>): boolean {
  if (HIDDEN_KEYS.has(key) || FOLDED_SUPPORT_KEYS.has(key)) return true;
  if (key === 'brim_object_gap' && isBrimOff(specs.brim_type)) return true;
  return false;
}

export function orderedSpecEntries(specs: Record<string, unknown>): [string, unknown][] {
  const seen = new Set<string>();
  const rows: [string, unknown][] = [];
  for (const key of SPEC_KEY_ORDER) {
    if (specs[key] == null || skipSpecKey(key, specs)) continue;
    rows.push([key, specs[key]]);
    seen.add(key);
  }
  for (const [key, value] of Object.entries(specs)) {
    if (seen.has(key) || value == null || skipSpecKey(key, specs)) continue;
    rows.push([key, value]);
  }
  return rows;
}

export function compactSpecItems(specs: Record<string, unknown>, t: Translate): string[] {
  const items: string[] = [];
  if (specs.layer_height != null) {
    items.push(formatSpecValue('layer_height', specs.layer_height, t));
  }
  if (specs.curr_bed_type != null) {
    items.push(
      t('fileManager.production.specs.summaryBed', {
        value: formatSpecValue('curr_bed_type', specs.curr_bed_type, t),
      }),
    );
  }
  if (specs.sparse_infill_density != null) {
    items.push(
      t('fileManager.production.specs.summaryInfill', {
        value: formatNumber(asNumber(specs.sparse_infill_density) ?? 0),
      }),
    );
  }
  if (specs.brim_type != null) {
    const brim = formatSpecValue('brim_type', specs.brim_type, t);
    const gap = asNumber(specs.brim_object_gap);
    if (!isBrimOff(specs.brim_type) && gap != null) {
      items.push(`${brim} · ${t('fileManager.production.specs.summaryBrimGap', { value: formatNumber(gap) })}`);
    } else {
      items.push(brim);
    }
  } else if (specs.brim_object_gap != null) {
    const gap = asNumber(specs.brim_object_gap);
    if (gap != null) {
      items.push(t('fileManager.production.specs.summaryBrimGap', { value: formatNumber(gap) }));
    }
  }
  if (specs.fuzzy_skin != null) {
    items.push(
      `${t('fileManager.production.specs.fuzzySkin')} ${formatSpecValue('fuzzy_skin', specs.fuzzy_skin, t)}`,
    );
  }
  if (specs.enable_support != null) {
    items.push(
      t('fileManager.production.specs.summarySupports', {
        detail: formatSupportsValue(specs, t),
      }),
    );
  }
  return items;
}

export function hasViewableSpecs(specs: Record<string, unknown>): boolean {
  return orderedSpecEntries(specs).length > 0;
}
