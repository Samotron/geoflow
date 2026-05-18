/**
 * DuckDB WASM initialisation and AGS table registration.
 *
 * Bundles are loaded from jsDelivr CDN on first use (lazy). Each AGS group
 * becomes a DuckDB table named after the lowercased group name, with column
 * names matching AGS heading names exactly.
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import type { AgsFile } from '../core.js';
import { downloadBlob, exportBaseName, exportDatePrefix } from '../export/utils.js';

export interface DbHandle {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
}

export interface TableMeta {
  name: string;
  rowCount: number;
  columns: string[];
}

export interface QueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  rowCount: number;
  durationMs: number;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

// Named path so the database is backed by a VFS file — required for export.
const DB_PATH = 'geoflow.duckdb';

let handle: DbHandle | null = null;

// Extensions auto-loaded after DuckDB is open. Loaded lazily on first use
// from the upstream extension repo — failures are logged but non-fatal so
// the rest of DuckDB remains usable offline or behind restrictive CSP.
const AUTOLOAD_EXTENSIONS = ['spatial', 'httpfs'] as const;

const loadedExtensions = new Set<string>();
const extensionLoadErrors = new Map<string, string>();

export interface ExtensionStatus {
  name: string;
  loaded: boolean;
  error: string | null;
}

export function getExtensionStatus(): ExtensionStatus[] {
  return AUTOLOAD_EXTENSIONS.map((name) => ({
    name,
    loaded: loadedExtensions.has(name),
    error: extensionLoadErrors.get(name) ?? null,
  }));
}

async function loadExtensions(conn: duckdb.AsyncDuckDBConnection): Promise<void> {
  for (const ext of AUTOLOAD_EXTENSIONS) {
    if (loadedExtensions.has(ext)) continue;
    try {
      await conn.query(`INSTALL ${ext}`);
      await conn.query(`LOAD ${ext}`);
      loadedExtensions.add(ext);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      extensionLoadErrors.set(ext, msg);
      // eslint-disable-next-line no-console
      console.warn(`[duckdb] failed to load extension "${ext}": ${msg}`);
    }
  }
}

async function getHandle(): Promise<DbHandle> {
  if (handle) return handle;

  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);

  // Create an inline worker that imports the chosen DuckDB bundle script.
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  // Open with a named path so the database can be copied out later.
  await db.open({ path: DB_PATH, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });

  const conn = await db.connect();
  await loadExtensions(conn);
  handle = { db, conn };
  return handle;
}

/**
 * Lists all main-schema tables/views currently registered in DuckDB.
 * Used by the transform engine to validate source nodes and to feed
 * editor autocomplete.
 */
export async function listMainSchemaTables(): Promise<TableMeta[]> {
  const { conn } = await getHandle();
  const tables = await conn.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'main'
    ORDER BY table_name
  `);
  const out: TableMeta[] = [];
  for (const row of tables.toArray()) {
    const name = String(row.table_name);
    if (name.startsWith('_')) continue;
    const cols = await conn.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'main' AND table_name = '${name.replace(/'/g, "''")}'
      ORDER BY ordinal_position
    `);
    const columns = cols.toArray().map((r) => String(r.column_name));
    const count = await conn.query(`SELECT COUNT(*)::BIGINT AS n FROM "${name.replace(/"/g, '""')}"`);
    const rowCount = Number((count.toArray()[0] as { n: bigint } | undefined)?.n ?? 0n);
    out.push({ name, rowCount, columns });
  }
  return out;
}

/**
 * Registers a seed (user-supplied CSV/JSON content) as a DuckDB table.
 * The relation name is lowercased to match the rest of the engine's
 * naming convention.
 */
export async function registerSeed(
  name: string,
  format: 'csv' | 'json',
  content: string,
): Promise<void> {
  const { db, conn } = await getHandle();
  const relName = name.toLowerCase();
  const fileName = `_seed_${relName}.${format}`;
  // Drop prior registration so seeds can be edited and re-run.
  try { await db.dropFile(fileName); } catch { /* not registered yet */ }
  await db.registerFileText(fileName, content);
  const reader = format === 'csv' ? `read_csv_auto('${fileName}')` : `read_json_auto('${fileName}')`;
  await conn.query(`CREATE OR REPLACE TABLE "${relName.replace(/"/g, '""')}" AS SELECT * FROM ${reader}`);
}

// ── AGS → DuckDB tables ───────────────────────────────────────────────────────

export async function registerAgsFile(
  agsFile: AgsFile,
  onProgress?: (msg: string) => void,
): Promise<TableMeta[]> {
  onProgress?.('Initialising DuckDB…');
  const { db, conn } = await getHandle();

  // Drop any tables from a previous file
  const existing = await conn.query(`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'
  `);
  for (const row of existing.toArray()) {
    const tbl = String(row.table_name);
    if (!tbl.startsWith('_')) {
      await conn.query(`DROP TABLE IF EXISTS "${tbl}"`);
    }
  }
  // Also drop any registered JSON files
  const registered = await db.globFiles('*.json');
  for (const f of registered) await db.dropFile(f.fileName);

  const metas: TableMeta[] = [];

  for (const [groupName, group] of Object.entries(agsFile.groups)) {
    if (!group || group.rows.length === 0) continue;

    const tableName = groupName.toLowerCase();
    onProgress?.(`Loading ${groupName} (${group.rows.length} rows)…`);

    // Serialise to JSON — DuckDB reads this with automatic type inference
    const jsonRows = group.rows.map((row) => {
      const obj: Record<string, string | number | boolean | null> = {};
      for (const h of group.headings) {
        const v = row[h.name];
        obj[h.name] = v === undefined ? null : (v as string | number | boolean | null);
      }
      return obj;
    });

    const fileName = `${tableName}.json`;
    await db.registerFileText(fileName, JSON.stringify(jsonRows));
    await conn.query(
      `CREATE OR REPLACE TABLE "${tableName}" AS SELECT * FROM read_json_auto('${fileName}')`,
    );

    metas.push({
      name: tableName,
      rowCount: group.rows.length,
      columns: group.headings.map((h) => h.name),
    });
  }

  return metas;
}

// ── Query execution ───────────────────────────────────────────────────────────

export async function runQuery(sql: string): Promise<QueryResult> {
  const { conn } = await getHandle();
  const t0 = performance.now();
  const result = await conn.query(sql);
  const durationMs = performance.now() - t0;

  const schema = result.schema.fields;
  const columns = schema.map((f) => f.name);
  const rows: (string | number | boolean | null)[][] = [];

  for (const row of result.toArray()) {
    rows.push(
      columns.map((col) => {
        const v = row[col];
        if (v === null || v === undefined) return null;
        if (typeof v === 'bigint') return Number(v);
        // Apache Arrow may wrap dates or decimals as objects
        if (typeof v === 'object') return String(v);
        return v as string | number | boolean;
      }),
    );
  }

  return { columns, rows, rowCount: rows.length, durationMs };
}

// ── DuckDB file export ────────────────────────────────────────────────────────

export async function exportAsDuckDb(
  agsFile: AgsFile,
  fileName: string | undefined,
  onProgress?: (msg: string) => void,
): Promise<void> {
  // Ensure tables are registered (idempotent if already loaded).
  await registerAgsFile(agsFile, onProgress);

  const { db, conn } = await getHandle();

  // Flush WAL so all committed data lands in the main database file.
  onProgress?.('Checkpointing…');
  await conn.query('CHECKPOINT');

  onProgress?.('Reading database bytes…');
  const bytes = await db.copyFileToBuffer(DB_PATH);

  const date = exportDatePrefix();
  const base = exportBaseName(fileName);
  downloadBlob(bytes, `${date}-${base}.duckdb`, 'application/octet-stream');
}
