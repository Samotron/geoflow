import { describe, expect, it } from 'vitest';
import { toAgsi, toAgsiJson } from './agsi.js';
import { defaultParameterValues } from './model.js';
import type { GroundModel } from './model.js';

function makeModel(): GroundModel {
  return {
    id: 'gm-1',
    name: 'North cluster',
    description: 'Phase 2 ground model — northern boreholes',
    group: {
      id: 'grp-1',
      name: 'Phase 2 north',
      locaIds: ['BH01', 'BH02', 'BH03'],
    },
    layers: [
      {
        id: 'layer-1',
        topRL: 30, baseRL: 27,
        unitKey: 'CL', name: 'Soft clay', description: 'Soft brown CLAY',
        color: '#7B9EC5',
        parameters: defaultParameterValues().map((p) =>
          p.key === 'cu' ? { ...p, value: 35, note: 'mean of 8 TCON results' } : p,
        ),
      },
      {
        id: 'layer-2',
        topRL: 27, baseRL: 20,
        unitKey: 'SA', name: 'Dense sand', description: 'Dense fine SAND',
        color: '#E8C840',
        parameters: defaultParameterValues(),
      },
    ],
    sampleStep: 0.25,
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
  };
}

describe('toAgsi', () => {
  it('emits the AGSi envelope with project + modelInstance', () => {
    const doc = toAgsi(makeModel(), 'Project A');
    expect(doc.$schema).toBe('https://gitlab.com/ags-data-format-wg/agsi');
    expect(doc.modelInstance.modelType).toBe('OneDimensional');
    expect(doc.modelInstance.verticalDatum).toBe('mAOD');
    expect(doc.project.projectName).toBe('Project A');
    expect(doc.project.informationSources).toHaveLength(3);
  });

  it('maps each layer to an Element with geometry + properties', () => {
    const doc = toAgsi(makeModel());
    expect(doc.modelInstance.elements).toHaveLength(2);
    const first = doc.modelInstance.elements[0]!;
    expect(first.geometry.type).toBe('OneDimensionalLayer');
    expect(first.geometry.topRL).toBe(30);
    expect(first.geometry.baseRL).toBe(27);
    expect(first.geometry.thickness).toBe(3);
    const cu = first.properties.find((p) => p.propertyCode === 'cu')!;
    expect(cu.propertyValue).toBe(35);
    expect(cu.remarks).toContain('mean');
  });

  it('toAgsiJson returns valid JSON', () => {
    const json = toAgsiJson(makeModel());
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
