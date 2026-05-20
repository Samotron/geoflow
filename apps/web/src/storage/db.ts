import type { Project, Commit, StoredPipeline, StoredGroundModel, StoredSearch } from './types.js';

const DB_NAME = 'geoflow';
const DB_VERSION = 5;

// Transparently upgrade commits written by the old schema (agsBytes field)
// to the new storage union without requiring a DB version bump.
function normalizeCommit(raw: Record<string, unknown>): Commit {
  if (raw['storage']) return raw as unknown as Commit;
  const bytes = raw['agsBytes'];
  return {
    ...(raw as unknown as Commit),
    storage: {
      kind: 'raw',
      bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer),
    },
  };
}

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      const oldVersion = e.oldVersion;

      if (oldVersion < 1) {
        const ps = db.createObjectStore('projects', { keyPath: 'id' });
        ps.createIndex('updatedAt', 'updatedAt');
      }

      // v2: drop project_files, add commits
      if (oldVersion < 2) {
        if (db.objectStoreNames.contains('project_files')) {
          db.deleteObjectStore('project_files');
        }
        const cs = db.createObjectStore('commits', { keyPath: 'id' });
        cs.createIndex('projectId', 'projectId');
        cs.createIndex('timestamp', 'timestamp');
      }

      // v3: transform pipelines
      if (oldVersion < 3) {
        const ps = db.createObjectStore('pipelines', { keyPath: 'id' });
        ps.createIndex('projectId', 'projectId');
        ps.createIndex('updatedAt', 'updatedAt');
      }

      // v4: ground models
      if (oldVersion < 4) {
        const gs = db.createObjectStore('ground_models', { keyPath: 'id' });
        gs.createIndex('projectId', 'projectId');
        gs.createIndex('updatedAt', 'updatedAt');
      }

      // v5: saved searches
      if (oldVersion < 5) {
        const ss = db.createObjectStore('saved_searches', { keyPath: 'id' });
        ss.createIndex('projectId', 'projectId');
        ss.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result;
      resolve(_db!);
    };
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll<T>(store: IDBObjectStore | IDBIndex, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = query !== undefined ? store.getAll(query) : store.getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(store: IDBObjectStore, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(store: IDBObjectStore, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── Projects ──────────────────────────────────────────────────────────────────

export async function getProjects(): Promise<Project[]> {
  const db = await openDb();
  const t = db.transaction('projects', 'readonly');
  const all = await idbGetAll<Project>(t.objectStore('projects').index('updatedAt'));
  return all.reverse();
}

export async function getProject(id: string): Promise<Project | undefined> {
  const db = await openDb();
  const t = db.transaction('projects', 'readonly');
  return idbGet<Project>(t.objectStore('projects'), id);
}

export async function saveProject(project: Project): Promise<void> {
  const db = await openDb();
  const t = db.transaction('projects', 'readwrite');
  await idbPut(t.objectStore('projects'), project);
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  const commits = await getProjectCommits(id);
  const t = db.transaction(['projects', 'commits'], 'readwrite');
  const commitStore = t.objectStore('commits');
  await Promise.all(commits.map((c) => idbDelete(commitStore, c.id)));
  await idbDelete(t.objectStore('projects'), id);
}

// ── Commits ───────────────────────────────────────────────────────────────────

export async function getProjectCommits(projectId: string): Promise<Commit[]> {
  const db = await openDb();
  const t = db.transaction('commits', 'readonly');
  const all = await idbGetAll<Record<string, unknown>>(
    t.objectStore('commits').index('projectId'),
    IDBKeyRange.only(projectId),
  );
  return all.map(normalizeCommit).sort((a, b) => b.timestamp - a.timestamp);
}

export async function getCommit(id: string): Promise<Commit | undefined> {
  const db = await openDb();
  const t = db.transaction('commits', 'readonly');
  const raw = await idbGet<Record<string, unknown>>(t.objectStore('commits'), id);
  return raw ? normalizeCommit(raw) : undefined;
}

export async function saveCommit(commit: Commit): Promise<void> {
  const db = await openDb();
  const t = db.transaction('commits', 'readwrite');
  await idbPut(t.objectStore('commits'), commit);
}

// ── Pipelines ─────────────────────────────────────────────────────────────────

export async function getProjectPipelines(projectId: string): Promise<StoredPipeline[]> {
  const db = await openDb();
  const t = db.transaction('pipelines', 'readonly');
  const all = await idbGetAll<StoredPipeline>(
    t.objectStore('pipelines').index('projectId'),
    IDBKeyRange.only(projectId),
  );
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getPipeline(id: string): Promise<StoredPipeline | undefined> {
  const db = await openDb();
  const t = db.transaction('pipelines', 'readonly');
  return idbGet<StoredPipeline>(t.objectStore('pipelines'), id);
}

export async function savePipeline(pipeline: StoredPipeline): Promise<void> {
  const db = await openDb();
  const t = db.transaction('pipelines', 'readwrite');
  await idbPut(t.objectStore('pipelines'), pipeline);
}

export async function deletePipeline(id: string): Promise<void> {
  const db = await openDb();
  const t = db.transaction('pipelines', 'readwrite');
  await idbDelete(t.objectStore('pipelines'), id);
}

// ── Ground models ─────────────────────────────────────────────────────────────

export async function getProjectGroundModels(projectId: string): Promise<StoredGroundModel[]> {
  const db = await openDb();
  const t = db.transaction('ground_models', 'readonly');
  const all = await idbGetAll<StoredGroundModel>(
    t.objectStore('ground_models').index('projectId'),
    IDBKeyRange.only(projectId),
  );
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getGroundModel(id: string): Promise<StoredGroundModel | undefined> {
  const db = await openDb();
  const t = db.transaction('ground_models', 'readonly');
  return idbGet<StoredGroundModel>(t.objectStore('ground_models'), id);
}

export async function saveGroundModel(model: StoredGroundModel): Promise<void> {
  const db = await openDb();
  const t = db.transaction('ground_models', 'readwrite');
  await idbPut(t.objectStore('ground_models'), model);
}

export async function deleteGroundModel(id: string): Promise<void> {
  const db = await openDb();
  const t = db.transaction('ground_models', 'readwrite');
  await idbDelete(t.objectStore('ground_models'), id);
}

// ── Saved searches ────────────────────────────────────────────────────────────

export async function getSavedSearches(projectId: string): Promise<StoredSearch[]> {
  const db = await openDb();
  const t = db.transaction('saved_searches', 'readonly');
  const all = await idbGetAll<StoredSearch>(
    t.objectStore('saved_searches').index('projectId'),
    IDBKeyRange.only(projectId),
  );
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveSavedSearch(search: StoredSearch): Promise<void> {
  const db = await openDb();
  const t = db.transaction('saved_searches', 'readwrite');
  await idbPut(t.objectStore('saved_searches'), search);
}

export async function deleteSavedSearch(id: string): Promise<void> {
  const db = await openDb();
  const t = db.transaction('saved_searches', 'readwrite');
  await idbDelete(t.objectStore('saved_searches'), id);
}
