import type { Project, ProjectFile } from './types.js';

const DB_NAME = 'geoflow';
const DB_VERSION = 1;

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('projects')) {
        const ps = db.createObjectStore('projects', { keyPath: 'id' });
        ps.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('project_files')) {
        const pf = db.createObjectStore('project_files', { keyPath: 'id' });
        pf.createIndex('projectId', 'projectId');
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

export async function getProjects(): Promise<Project[]> {
  const db = await openDb();
  const t = db.transaction('projects', 'readonly');
  const idx = t.objectStore('projects').index('updatedAt');
  const all = await idbGetAll<Project>(idx);
  return all.reverse(); // most recently updated first
}

export async function saveProject(project: Project): Promise<void> {
  const db = await openDb();
  const t = db.transaction('projects', 'readwrite');
  await idbPut(t.objectStore('projects'), project);
}

export async function deleteProject(id: string): Promise<void> {
  const files = await getProjectFiles(id);
  const db = await openDb();
  const t = db.transaction(['projects', 'project_files'], 'readwrite');
  const fileStore = t.objectStore('project_files');
  await Promise.all(files.map((f) => idbDelete(fileStore, f.id)));
  await idbDelete(t.objectStore('projects'), id);
}

export async function getProjectFiles(projectId: string): Promise<ProjectFile[]> {
  const db = await openDb();
  const t = db.transaction('project_files', 'readonly');
  const idx = t.objectStore('project_files').index('projectId');
  const all = await idbGetAll<ProjectFile>(idx, IDBKeyRange.only(projectId));
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

export async function saveProjectFile(file: ProjectFile): Promise<void> {
  const db = await openDb();
  const t = db.transaction('project_files', 'readwrite');
  await idbPut(t.objectStore('project_files'), file);
}

export async function deleteProjectFile(id: string): Promise<void> {
  const db = await openDb();
  const t = db.transaction('project_files', 'readwrite');
  await idbDelete(t.objectStore('project_files'), id);
}

export async function getProjectFile(id: string): Promise<ProjectFile | undefined> {
  const db = await openDb();
  const t = db.transaction('project_files', 'readonly');
  return idbGet<ProjectFile>(t.objectStore('project_files'), id);
}
