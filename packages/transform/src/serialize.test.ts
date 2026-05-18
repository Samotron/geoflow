import { describe, it, expect } from 'vitest';
import { emptyPipeline } from './model.js';
import { exportToString, parseExport } from './serialize.js';

describe('serialize', () => {
  it('round-trips an empty pipeline', () => {
    const p = emptyPipeline('id-1', 'demo');
    const s = exportToString(p);
    const back = parseExport(s);
    expect(back.id).toBe('id-1');
    expect(back.name).toBe('demo');
    expect(back.nodes).toEqual([]);
  });

  it('rejects unknown formats', () => {
    expect(() => parseExport(JSON.stringify({ format: 'other' }))).toThrow(/Unknown pipeline format/);
  });

  it('rejects unsupported schema versions', () => {
    expect(() => parseExport(JSON.stringify({ format: 'geoflow-pipeline', schemaVersion: 99 }))).toThrow(/schema version/);
  });

  it('rejects non-object input', () => {
    expect(() => parseExport('"oops"')).toThrow(/not an object/);
  });
});
