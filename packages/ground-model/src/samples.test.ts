/**
 * End-to-end test: load a real AGS fixture, build a skeleton, extract
 * channel samples, compute stats, and serialise to AGSi. Catches the
 * kind of integration bug a typecheck would miss.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseStr } from '@geoflow/core';
import { buildSkeleton } from './skeleton.js';
import { extractChannel, samplesInRange, locaGroundLevels, CHANNELS } from './samples.js';
import { describe as describeStats } from './stats.js';
import { defaultParameterValues } from './model.js';
import { toAgsi } from './agsi.js';
import type { GroundModel } from './model.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(resolve(HERE, '../../../tests/fixtures/ags', name), 'utf-8');
}

describe('end-to-end ground model pipeline', () => {
  it('runs against the browser_explorer fixture without crashing', () => {
    const text = loadFixture('browser_explorer.ags');
    const { file } = parseStr(text);
    expect(file).not.toBeNull();
    const locaIds = (file.groups['LOCA']?.rows ?? [])
      .map((r) => String(r['LOCA_ID'] ?? '').trim())
      .filter(Boolean);
    expect(locaIds.length).toBeGreaterThan(0);

    // Skeleton uses all locations.
    const skel = buildSkeleton(file, locaIds);
    expect(skel.meanGL).toBeTypeOf('number');
    // Boundary suggestions may be empty for sparse fixtures — just shouldn't throw.
    expect(Array.isArray(skel.boundaries)).toBe(true);

    // Channel extraction shouldn't throw on any channel.
    for (const ch of CHANNELS) {
      const samples = extractChannel(file, ch.key, locaIds);
      expect(Array.isArray(samples)).toBe(true);
      // samplesInRange should not include points outside the layer.
      if (skel.layers.length > 0) {
        const layer = skel.layers[0]!;
        const inLayer = samplesInRange(samples, layer.topRL, layer.baseRL);
        for (const s of inLayer) {
          expect(s.rl).toBeLessThanOrEqual(layer.topRL + 1e-6);
          expect(s.rl).toBeGreaterThanOrEqual(layer.baseRL - 1e-6);
        }
      }
    }

    // Building a ground model and serialising to AGSi should produce valid JSON.
    const model: GroundModel = {
      id: 'gm-test',
      name: 'fixture test',
      description: '',
      group: { id: 'grp', name: 'all', locaIds },
      layers: skel.layers.map((l) => ({ ...l, parameters: defaultParameterValues() })),
      sampleStep: 0.25,
      createdAt: 0, updatedAt: 0,
    };
    const doc = toAgsi(model, 'Fixture');
    expect(doc.modelInstance.elements).toHaveLength(model.layers.length);
    expect(() => JSON.stringify(doc)).not.toThrow();
  });

  it('locaGroundLevels returns LOCA_ID → LOCA_GL map', () => {
    const text = loadFixture('browser_explorer.ags');
    const { file } = parseStr(text);
    const gls = locaGroundLevels(file);
    expect(gls.size).toBeGreaterThan(0);
    for (const [id, gl] of gls) {
      expect(typeof id).toBe('string');
      expect(Number.isFinite(gl)).toBe(true);
    }
  });

  it('stats on an empty sample list returns count=0', () => {
    const s = describeStats([]);
    expect(s.count).toBe(0);
  });

  it('skeleton exposes per-borehole contacts derived from GEOL', () => {
    const text = loadFixture('browser_explorer.ags');
    const { file } = parseStr(text);
    const locaIds = (file.groups['LOCA']?.rows ?? [])
      .map((r) => String(r['LOCA_ID'] ?? '').trim())
      .filter(Boolean);
    const skel = buildSkeleton(file, locaIds);
    expect(Array.isArray(skel.perBoreholeContacts)).toBe(true);
    // At least one borehole should have at least one contact.
    const totalContacts = skel.perBoreholeContacts.reduce((a, b) => a + b.contacts.length, 0);
    expect(totalContacts).toBeGreaterThan(0);
    // Every contact's RL should be at-or-below ground level.
    for (const bh of skel.perBoreholeContacts) {
      if (bh.groundLevel === undefined) continue;
      for (const c of bh.contacts) {
        expect(c.rl).toBeLessThanOrEqual(bh.groundLevel + 1e-6);
      }
    }
  });
});
