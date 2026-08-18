import { describe, it, expect } from 'vitest';
import {
  compactSpecItems,
  formatSpecValue,
  formatSupportsValue,
  mergeProductionSpecs,
  orderedSpecEntries,
} from '../../utils/productionSpecs';

const t = (key: string, options?: Record<string, unknown>) => {
  if (key.endsWith('valueMm')) return `${options?.value} mm`;
  if (key.endsWith('valuePercent')) return `${options?.value}%`;
  if (key.endsWith('summaryInfill')) return `${options?.value}% infill`;
  if (key.endsWith('summarySupports')) return `Supports: ${options?.detail}`;
  if (key.endsWith('summaryBrimGap')) return `${options?.value} mm gap`;
  if (key.endsWith('.on')) return 'On';
  if (key.endsWith('.off')) return 'Off';
  if (key.endsWith('brimAuto')) return 'Auto brim';
  if (key.endsWith('brimNone')) return 'No brim';
  if (key.endsWith('brimOuter')) return 'Outer only';
  if (key.endsWith('nozzlesBoth')) return 'Both';
  if (key.endsWith('fuzzySkinPainted')) return 'Painted';
  if (key.endsWith('fuzzySkinAllowPaint')) return 'Allow paint';
  if (key.endsWith('fuzzySkin')) return 'Fuzzy skin';
  if (key.endsWith('supportTreeAuto')) return 'Tree auto';
  if (key.endsWith('supportNormalAuto')) return 'Normal auto';
  if (key.endsWith('supportStyleSlim')) return 'Tree slim';
  if (key.endsWith('supportStyleHybrid')) return 'Hybrid';
  if (key.endsWith('supportStyleStrong')) return 'Strong';
  if (key.endsWith('supportStyleOrganic')) return 'Organic';
  if (key.endsWith('infillPatterns.concentric')) return 'Concentric';
  if (key.endsWith('infillPatterns.rectilinear')) return 'Rectilinear';
  if (key.endsWith('infillPatterns.monotonic')) return 'Monotonic';
  if (key.endsWith('infillPatterns.monotonicLine')) return 'Monotonic line';
  if (key.endsWith('infillPatterns.alignedRectilinear')) return 'Aligned Rectilinear';
  if (key.endsWith('infillPatterns.hilbertCurve')) return 'Hilbert Curve';
  if (key.endsWith('infillPatterns.archimedeanChords')) return 'Archimedean Chords';
  if (key.endsWith('infillPatterns.octagramSpiral')) return 'Octagram Spiral';
  return key;
};

describe('mergeProductionSpecs', () => {
  it('overlays slot overrides on locked parameters and drops gating metadata', () => {
    const merged = mergeProductionSpecs(
      { layer_height: 0.2, sparse_infill_density: 20, _multi_color: true },
      { layer_height: 0.16, brim_type: 'outer_only' },
    );
    expect(merged).toEqual({
      layer_height: 0.16,
      sparse_infill_density: 20,
      brim_type: 'outer_only',
    });
  });
});

describe('formatSpecValue', () => {
  it('formats mm, percent, brim, fuzzy skin, and nozzles', () => {
    expect(formatSpecValue('layer_height', 0.2, t)).toBe('0.2 mm');
    expect(formatSpecValue('sparse_infill_density', 20, t)).toBe('20%');
    expect(formatSpecValue('brim_type', 'auto_brim', t)).toBe('Auto brim');
    expect(formatSpecValue('brim_object_gap', 0.1, t)).toBe('0.1 mm');
    expect(formatSpecValue('fuzzy_skin', 'none', t)).toBe('Allow paint');
    expect(formatSpecValue('fuzzy_skin', 'all', t)).toBe('On');
    expect(formatSpecValue('fuzzy_skin', 'paint', t)).toBe('Painted');
    expect(formatSpecValue('fuzzy_skin', 'disabled_fuzzy', t)).toBe('Off');
    expect(formatSpecValue('enable_support', false, t)).toBe('Off');
    expect(formatSpecValue('nozzles_used', 'both', t)).toBe('Both');
  });

  it('formats tree_slim and tree_hybrid readably', () => {
    expect(formatSpecValue('support_type', 'tree(auto)', t)).toBe('Tree auto');
    expect(formatSpecValue('support_type', 'normal(auto)', t)).toBe('Normal auto');
    expect(formatSpecValue('support_style', 'tree_slim', t)).toBe('Tree slim');
    expect(formatSpecValue('support_style', 'tree_hybrid', t)).toBe('Hybrid');
    expect(formatSpecValue('support_style', 'tree_strong', t)).toBe('Strong');
    expect(formatSpecValue('support_style', 'organic', t)).toBe('Organic');
  });

  it('formats first-layer line width as mm, not percent', () => {
    expect(formatSpecValue('initial_layer_line_width', 0.42, t)).toBe('0.42 mm');
    expect(formatSpecValue('initial_layer_line_width', '0.42mm', t)).toBe('0.42 mm');
    expect(formatSpecValue('initial_layer_line_width', '105%', t)).toBe('105%');
  });

  it('maps infill pattern tokens to Bambu slicer labels', () => {
    expect(formatSpecValue('sparse_infill_pattern', 'rectilinear', t)).toBe('Rectilinear');
    expect(formatSpecValue('sparse_infill_pattern', 'zigzag', t)).toBe('Rectilinear');
    expect(formatSpecValue('sparse_infill_pattern', 'zig-zag', t)).toBe('Rectilinear');
    expect(formatSpecValue('sparse_infill_pattern', 'monotonicline', t)).toBe('Monotonic line');
    expect(formatSpecValue('sparse_infill_pattern', 'monotonic_line', t)).toBe('Monotonic line');
    expect(formatSpecValue('sparse_infill_pattern', 'hilbertcurve', t)).toBe('Hilbert Curve');
    expect(formatSpecValue('sparse_infill_pattern', 'gyroid', t)).toBe('Gyroid');
  });
});

describe('formatSupportsValue', () => {
  it('shows Off without style when supports are disabled', () => {
    expect(
      formatSupportsValue({ enable_support: false, support_type: 'tree(auto)', support_style: 'tree_slim' }, t),
    ).toBe('Off');
  });

  it('joins tree auto with slim style when supports are on', () => {
    expect(
      formatSupportsValue({ enable_support: true, support_type: 'tree(auto)', support_style: 'tree_slim' }, t),
    ).toBe('Tree auto · Tree slim');
  });
});

describe('compactSpecItems', () => {
  it('summarizes layer height, infill, brim, and fuzzy skin', () => {
    expect(
      compactSpecItems(
        {
          layer_height: 0.2,
          sparse_infill_density: 20,
          brim_type: 'auto_brim',
          fuzzy_skin: 'none',
        },
        t,
      ),
    ).toEqual(['0.2 mm', '20% infill', 'Auto brim', 'Fuzzy skin Allow paint']);
  });

  it('summarizes painted fuzzy skin instead of Off', () => {
    expect(compactSpecItems({ fuzzy_skin: 'paint' }, t)).toEqual(['Fuzzy skin Painted']);
  });

  it('appends brim-object gap when brim is on and omits it when brim is off', () => {
    expect(
      compactSpecItems({ brim_type: 'auto_brim', brim_object_gap: 0.1 }, t),
    ).toEqual(['Auto brim · 0.1 mm gap']);
    expect(
      compactSpecItems({ brim_type: 'no_brim', brim_object_gap: 0.1 }, t),
    ).toEqual(['No brim']);
  });

  it('summarizes supports off without style and on with tree slim', () => {
    expect(
      compactSpecItems(
        { enable_support: false, support_type: 'tree(auto)', support_style: 'tree_slim' },
        t,
      ),
    ).toEqual(['Supports: Off']);
    expect(
      compactSpecItems(
        { enable_support: true, support_type: 'tree(auto)', support_style: 'tree_slim' },
        t,
      ),
    ).toEqual(['Supports: Tree auto · Tree slim']);
  });
});

describe('orderedSpecEntries', () => {
  it('follows contract key order and skips hidden keys', () => {
    const rows = orderedSpecEntries({
      _multi_color: true,
      nozzles_used: 'left',
      layer_height: 0.2,
      wall_loops: 3,
    });
    expect(rows.map(([key]) => key)).toEqual(['layer_height', 'wall_loops', 'nozzles_used']);
  });

  it('folds support type and style into Supports and hides gap when brim is off', () => {
    const rows = orderedSpecEntries({
      layer_height: 0.2,
      brim_type: 'no_brim',
      brim_object_gap: 0.1,
      enable_support: true,
      support_type: 'tree(auto)',
      support_style: 'tree_slim',
    });
    expect(rows.map(([key]) => key)).toEqual(['layer_height', 'brim_type', 'enable_support']);
  });

  it('includes brim-object gap when brim is on', () => {
    const rows = orderedSpecEntries({
      brim_type: 'auto_brim',
      brim_object_gap: 0.1,
    });
    expect(rows.map(([key]) => key)).toEqual(['brim_type', 'brim_object_gap']);
  });
});
