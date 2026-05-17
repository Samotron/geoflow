import type { Project, Commit } from './types.js';

const DB_NAME = 'geoflow';
const DB_VERSION = 2;

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
