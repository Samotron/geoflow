// Built-in rule packs bundled at build time.
// The YAML strings come from a Vite virtual module so the source-of-truth
// pack files live under rules/specs/ at the repo root.

import { agsStandard } from 'virtual:geoflow-packs';

export interface BundledPack {
  id: string;
  label: string;
  description: string;
  version: string;
  yaml: string;
}

export const BUILTIN_PACKS: BundledPack[] = [
  {
    id: 'ags-standard-4x',
    label: 'AGS 4.x Standard',
    description: 'Structural, key, foreign-key and value checks per the AGS 4.x specification.',
    version: '4.x',
    yaml: agsStandard,
  },
];

export const DEFAULT_ENABLED_PACK_IDS = new Set(BUILTIN_PACKS.map((p) => p.id));
