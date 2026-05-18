import type { Pipeline } from '@geoflow/transform';
import { emptyPipeline, exportToString, parseExport } from '@geoflow/transform';
import type { StoredPipeline } from '../storage/types.js';
import {
  deletePipeline as dbDeletePipeline,
  getProjectPipelines,
  savePipeline as dbSavePipeline,
} from '../storage/db.js';

export async function loadPipelinesForProject(projectId: string): Promise<Pipeline[]> {
  const stored = await getProjectPipelines(projectId);
  return stored.map((s) => {
    try {
      const obj = JSON.parse(s.json) as unknown;
      // Stored shape is the bare Pipeline object (not wrapped).
      return obj as Pipeline;
    } catch {
      // Fall back to an empty pipeline named after the stored row
      // so a corrupt entry doesn't break the manager.
      return emptyPipeline(s.id, s.name, s.projectId);
    }
  });
}

export async function savePipelineForProject(projectId: string, pipeline: Pipeline): Promise<void> {
  const json = JSON.stringify(pipeline);
  const record: StoredPipeline = {
    id: pipeline.id,
    projectId,
    name: pipeline.name,
    json,
    createdAt: pipeline.createdAt,
    updatedAt: Date.now(),
  };
  await dbSavePipeline(record);
}

export async function deletePipelineById(id: string): Promise<void> {
  await dbDeletePipeline(id);
}

export function exportPipeline(pipeline: Pipeline): Blob {
  return new Blob([exportToString(pipeline)], { type: 'application/json' });
}

export async function importPipelineFromFile(file: File): Promise<Pipeline> {
  const text = await file.text();
  const pipeline = parseExport(text);
  // Force a new id so import never silently overwrites a pre-existing pipeline.
  return {
    ...pipeline,
    id: crypto.randomUUID(),
    updatedAt: Date.now(),
  };
}
