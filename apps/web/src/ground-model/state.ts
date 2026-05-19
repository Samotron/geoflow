/**
 * state.ts — React hook + IndexedDB CRUD for ground models scoped to the
 * current project (or the synthetic '_session' project when none is
 * active). Mirrors the pattern used by `transform/persistence.ts`.
 */

import { useCallback, useEffect, useState } from 'react';
import type { GroundModel } from '@geoflow/ground-model';
import type { StoredGroundModel } from '../storage/types.js';
import {
  getProjectGroundModels,
  saveGroundModel as dbSave,
  deleteGroundModel as dbDelete,
} from '../storage/db.js';

const SESSION_PROJECT_ID = '_session';

function pid(projectId: string | null): string {
  return projectId ?? SESSION_PROJECT_ID;
}

function pack(model: GroundModel, projectId: string | null): StoredGroundModel {
  return {
    id: model.id,
    projectId: pid(projectId),
    name: model.name,
    json: JSON.stringify(model),
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function unpack(stored: StoredGroundModel): GroundModel | null {
  try {
    return JSON.parse(stored.json) as GroundModel;
  } catch {
    return null;
  }
}

export interface UseGroundModelsResult {
  models: GroundModel[];
  loading: boolean;
  /** Reload from IndexedDB. */
  refresh: () => Promise<void>;
  /** Insert or update. Writes through to IndexedDB. */
  save: (model: GroundModel) => Promise<void>;
  /** Remove by id. */
  remove: (id: string) => Promise<void>;
}

export function useGroundModels(projectId: string | null): UseGroundModelsResult {
  const [models, setModels] = useState<GroundModel[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const stored = await getProjectGroundModels(pid(projectId));
      setModels(stored.map(unpack).filter((m): m is GroundModel => m !== null));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async (model: GroundModel) => {
    await dbSave(pack(model, projectId));
    setModels((prev) => {
      const idx = prev.findIndex((m) => m.id === model.id);
      if (idx === -1) return [model, ...prev];
      const copy = [...prev];
      copy[idx] = model;
      return copy;
    });
  }, [projectId]);

  const remove = useCallback(async (id: string) => {
    await dbDelete(id);
    setModels((prev) => prev.filter((m) => m.id !== id));
  }, []);

  return { models, loading, refresh, save, remove };
}
