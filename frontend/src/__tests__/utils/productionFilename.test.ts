import { describe, it, expect } from 'vitest';
import {
  formatProductionFilename,
  normalizeProductionPrinter,
  parseProductionFilename,
  printerModelsMatch,
  resolvePrintTargetModel,
  storedProductionFilename,
} from '../../utils/productionFilename';

describe('parseProductionFilename', () => {
  it('parses CODE xQTY - M.R.m - PRINTER with .gcode.3mf', () => {
    const parsed = parseProductionFilename('TOP x2 - 1.13.2 - X1C.gcode.3mf');
    expect(parsed).toEqual({
      code: 'TOP',
      quantity: 2,
      major: 1,
      revision: 13,
      minor: 2,
      printer: 'X1C',
      version: '1.13.2',
    });
  });

  it('parses omitted quantity as x1 with a printer suffix', () => {
    const parsed = parseProductionFilename('TOP - 1.13.2 - X1C');
    expect(parsed).toEqual({
      code: 'TOP',
      quantity: 1,
      major: 1,
      revision: 13,
      minor: 2,
      printer: 'X1C',
      version: '1.13.2',
    });
  });

  it('defaults quantity to 1 when omitted', () => {
    const parsed = parseProductionFilename('BOT - 2.0.1 - A1 Mini.3mf');
    expect(parsed?.quantity).toBe(1);
    expect(parsed?.code).toBe('BOT');
    expect(parsed?.printer).toBe('A1M');
  });

  it('rejects a missing printer suffix', () => {
    expect(parseProductionFilename('TOP - 1.13.2')).toBeNull();
    expect(parseProductionFilename('TOP x2 - 1.13.2')).toBeNull();
  });

  it('returns null when the name is not a production filename', () => {
    expect(parseProductionFilename('benchy.gcode.3mf')).toBeNull();
  });
});

describe('formatProductionFilename', () => {
  it('omits x1 and keeps quantity in the stem', () => {
    expect(formatProductionFilename('TOP', 1, 1, 0, 0, 'X1C')).toBe('TOP - 1.0.0 - X1C');
    expect(formatProductionFilename('TOP', 2, 1, 13, 2, 'X1C')).toBe('TOP x2 - 1.13.2 - X1C');
    expect(formatProductionFilename('top', 1, 1, 0, 0, 'A1 Mini')).toBe('TOP - 1.0.0 - A1M');
  });

  it('appends the original print-file extension', () => {
    expect(storedProductionFilename('13_Slot_Buide_Plate_V2(2).3mf', 'TOP', 1, 1, 0, 0, 'X1C'))
      .toBe('TOP - 1.0.0 - X1C.3mf');
    expect(storedProductionFilename('random.gcode.3mf', 'TOP', 2, 1, 0, 0, 'X1C'))
      .toBe('TOP x2 - 1.0.0 - X1C.gcode.3mf');
  });
});

describe('normalizeProductionPrinter', () => {
  it('maps compact and display names to production codes', () => {
    expect(normalizeProductionPrinter('X1 Carbon')).toBe('X1C');
    expect(normalizeProductionPrinter('A1 Mini')).toBe('A1M');
    expect(normalizeProductionPrinter('a1m')).toBe('A1M');
  });
});

describe('printerModelsMatch', () => {
  it('treats A1M and A1 Mini as the same printer', () => {
    expect(printerModelsMatch('A1M', 'A1 Mini')).toBe(true);
    expect(printerModelsMatch('A1 Mini', 'A1M')).toBe(true);
    expect(printerModelsMatch('Bambu Lab A1 Mini', 'A1M')).toBe(true);
  });

  it('does not treat A1 and A1 Mini as the same printer', () => {
    expect(printerModelsMatch('A1', 'A1 Mini')).toBe(false);
    expect(printerModelsMatch('A1', 'A1M')).toBe(false);
  });

  it('maps X1 Carbon to X1C and leaves other models distinct', () => {
    expect(printerModelsMatch('X1 Carbon', 'X1C')).toBe(true);
    expect(printerModelsMatch('X1C', 'P1S')).toBe(false);
    expect(printerModelsMatch('H2D', 'H2S')).toBe(false);
  });
});

describe('resolvePrintTargetModel', () => {
  it('prefers sliced_for_model over the filename suffix', () => {
    expect(resolvePrintTargetModel('A1 Mini', 'TOP x1 - 1.13.2 - X1C.gcode.3mf')).toBe('A1 Mini');
  });

  it('parses the production filename when slice metadata is missing', () => {
    expect(resolvePrintTargetModel(null, 'TOP x1 - 1.13.2 - A1M.gcode.3mf')).toBe('A1M');
    expect(resolvePrintTargetModel('', 'BOT - 2.0.1 - A1 Mini.3mf')).toBe('A1M');
  });

  it('returns null for an ordinary file with no slice metadata', () => {
    expect(resolvePrintTargetModel(null, 'benchy.gcode.3mf')).toBeNull();
  });
});
