import { describe, it, expect } from 'vitest';
import { parseProductionFilename, normalizeProductionPrinter } from '../../utils/productionFilename';

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

describe('normalizeProductionPrinter', () => {
  it('maps compact and display names to production codes', () => {
    expect(normalizeProductionPrinter('X1 Carbon')).toBe('X1C');
    expect(normalizeProductionPrinter('A1 Mini')).toBe('A1M');
    expect(normalizeProductionPrinter('a1m')).toBe('A1M');
  });
});
