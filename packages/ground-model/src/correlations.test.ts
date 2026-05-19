import { describe, expect, it } from 'vitest';
import { buildLayerInputs, correlationsForParameter, runCorrelations } from './correlations.js';

describe('runCorrelations', () => {
  it('produces phi correlations for granular soil with SPT data', () => {
    const inputs = buildLayerInputs(
      {
        spt: [
          { value: 20, rl: 25, depth: 5, ref: { locaId: 'BH1', group: 'ISPT', rowIndex: 0 } },
          { value: 30, rl: 24, depth: 6, ref: { locaId: 'BH1', group: 'ISPT', rowIndex: 1 } },
        ],
      },
      { topRL: 26, baseRL: 22, meanGL: 30, family: 'granular' },
    );
    const results = runCorrelations(inputs);
    const phi = correlationsForParameter(results, 'phi');
    expect(phi.length).toBeGreaterThan(2); // multiple phi correlations
    for (const r of phi) {
      expect(r.representative).toBeDefined();
      expect(r.representative!).toBeGreaterThan(20);
      expect(r.representative!).toBeLessThan(50);
    }
  });

  it('skips phi correlations and emits cu correlations for cohesive soil', () => {
    const inputs = buildLayerInputs(
      {
        spt: [{ value: 8, rl: 20, depth: 10, ref: { locaId: 'BH1', group: 'ISPT', rowIndex: 0 } }],
        pi: [{ value: 25, rl: 20, depth: 10, ref: { locaId: 'BH1', group: 'LLPL', rowIndex: 0 } }],
      },
      { topRL: 22, baseRL: 18, meanGL: 30, family: 'cohesive' },
    );
    const results = runCorrelations(inputs);
    expect(correlationsForParameter(results, 'phi')).toHaveLength(0);
    expect(correlationsForParameter(results, 'cu').length).toBeGreaterThan(2);
  });

  it('produces gamma correlations from a bulk density sample', () => {
    const inputs = buildLayerInputs(
      {
        bulkDensity: [{ value: 1.9, rl: 20, depth: 10, ref: { locaId: 'BH1', group: 'RDEN', rowIndex: 0 } }],
      },
      { topRL: 22, baseRL: 18, meanGL: 30 },
    );
    const results = runCorrelations(inputs);
    const gamma = correlationsForParameter(results, 'gamma');
    expect(gamma.length).toBeGreaterThanOrEqual(1);
    const fromBd = gamma.find((g) => g.label.includes('ρb'));
    expect(fromBd).toBeDefined();
    expect(fromBd!.representative).toBeCloseTo(1.9 * 9.81, 1);
  });

  it('infers PI from LL and PL when PI not supplied', () => {
    const inputs = buildLayerInputs(
      {
        ll: [{ value: 50, rl: 20, depth: 10, ref: { locaId: 'BH1', group: 'LLPL', rowIndex: 0 } }],
        pl: [{ value: 22, rl: 20, depth: 10, ref: { locaId: 'BH1', group: 'LLPL', rowIndex: 0 } }],
      },
      { topRL: 22, baseRL: 18, meanGL: 30, family: 'cohesive' },
    );
    expect(inputs.pi).toBeCloseTo(28, 1);
  });

  it('skips SPT- and density-based correlations when those inputs are absent', () => {
    const inputs = buildLayerInputs({}, { topRL: 22, baseRL: 18, meanGL: 30 });
    const results = runCorrelations(inputs);
    // No SPT samples → no phi/Dr/Vs from N
    expect(results.find((r) => r.label.includes('N₆₀') || r.label.includes('N₁,₆₀'))).toBeUndefined();
    // No density samples → no γ from ρb/ρd
    expect(results.find((r) => r.label.includes('ρb') || r.label.includes('ρd'))).toBeUndefined();
  });
});
