import { Option } from 'effect';
import { parseStr, decodeBytes, serialize } from './core.js';
import type { AgsFile, AgsGroup, AgsHeading, AgsRow } from './core.js';
import type { AgsFileDelta, Commit } from './storage/types.js';

// ── Compression ───────────────────────────────────────────────────────────────

async function collectStream(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  await writer.write(bytes as unknown as Uint8Array<ArrayBuffer>);
  await writer.close();
  return collectStream(cs.readable);
}

export async function decompress(gz: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  await writer.write(gz as unknown as Uint8Array<ArrayBuffer>);
  await writer.close();
  return collectStream(ds.readable);
}

// ── Row helpers ───────────────────────────────────────────────────────────────

function norm(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Y' : 'N';
  return String(v);
}

function pkNames(headings: AgsHeading[]): string[] {
  return headings.filter((h) => h.data_type === 'ID').map((h) => h.name);
}

function rowKey(row: AgsRow, pks: string[]): string {
  return pks.map((h) => norm(row[h])).join('\0');
}

function rowsEqual(a: AgsRow, b: AgsRow, headings: AgsHeading[]): boolean {
  return headings.every((h) => norm(a[h.name]) === norm(b[h.name]));
}

function headingsEqual(a: AgsHeading[], b: AgsHeading[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((h, i) => {
    const bh = b[i]!;
    return h.name === bh.name && h.unit === bh.unit && h.data_type === bh.data_type;
  });
}

// ── Delta computation ─────────────────────────────────────────────────────────

export function computeDelta(before: AgsFile, after: AgsFile): AgsFileDelta {
  const delta: AgsFileDelta = { groups: {} };

  for (const name of Object.keys(before.groups)) {
    if (!after.groups[name]) {
      delta.removedGroups ??= [];
      delta.removedGroups.push(name);
    }
  }

  for (const [name, afterGroup] of Object.entries(after.groups)) {
    if (!afterGroup) continue;
    const beforeGroup = before.groups[name];

    if (!beforeGroup) {
      delta.groups[name] = { headings: afterGroup.headings, upserted: afterGroup.rows, replace: true };
      continue;
    }

    const gd: AgsFileDelta['groups'][string] = {};
    if (!headingsEqual(beforeGroup.headings, afterGroup.headings)) gd.headings = afterGroup.headings;

    const pks = pkNames(afterGroup.headings);
    if (pks.length === 0) {
      const same =
        beforeGroup.rows.length === afterGroup.rows.length &&
        afterGroup.rows.every((r, i) => rowsEqual(r, beforeGroup.rows[i]!, afterGroup.headings));
      if (!same) { gd.upserted = afterGroup.rows; gd.replace = true; }
    } else {
      const beforeMap = new Map<string, AgsRow>();
      for (const row of beforeGroup.rows) beforeMap.set(rowKey(row, pks), row);
      const afterMap = new Map<string, AgsRow>();
      for (const row of afterGroup.rows) afterMap.set(rowKey(row, pks), row);

      for (const pk of beforeMap.keys()) {
        if (!afterMap.has(pk)) { gd.deleted ??= []; gd.deleted.push(pk); }
      }
      for (const [pk, afterRow] of afterMap) {
        const beforeRow = beforeMap.get(pk);
        if (!beforeRow || !rowsEqual(beforeRow, afterRow, afterGroup.headings)) {
          gd.upserted ??= []; gd.upserted.push(afterRow);
        }
      }
    }

    if (gd.headings ?? gd.upserted ?? gd.deleted ?? gd.replace) delta.groups[name] = gd;
  }

  return delta;
}

// ── Delta application ─────────────────────────────────────────────────────────

export function applyDelta(base: AgsFile, delta: AgsFileDelta): AgsFile {
  const groups: Record<string, AgsGroup> = { ...base.groups };

  for (const name of (delta.removedGroups ?? [])) delete groups[name];

  for (const [name, gd] of Object.entries(delta.groups)) {
    const baseGroup = groups[name];
    const headings = gd.headings ?? baseGroup?.headings ?? [];

    if (!baseGroup) {
      groups[name] = { name, headings, rows: gd.upserted ?? [], source_line: Option.none() };
      continue;
    }

    let rows: AgsRow[];
    const pks = pkNames(headings);
    if (gd.replace || pks.length === 0) {
      rows = gd.upserted ?? [];
    } else {
      const rowMap = new Map<string, AgsRow>();
      for (const row of baseGroup.rows) rowMap.set(rowKey(row, pks), row);
      for (const pk of (gd.deleted ?? [])) rowMap.delete(pk);
      for (const row of (gd.upserted ?? [])) rowMap.set(rowKey(row, pks), row);
      rows = [...rowMap.values()];
    }

    groups[name] = { ...baseGroup, headings, rows };
  }

  return { ...base, groups };
}

// ── Reconstruction ────────────────────────────────────────────────────────────

export async function reconstructAgsBytes(
  commit: Commit,
  getCommit: (id: string) => Promise<Commit | undefined>,
): Promise<Uint8Array> {
  if (commit.storage.kind === 'raw') return commit.storage.bytes;

  // Walk up to nearest snapshot ancestor
  const chain: Commit[] = [commit];
  let cur = commit;
  while (cur.storage.kind === 'delta') {
    if (!cur.parentId) throw new Error(`Delta commit ${cur.id} has no parent`);
    const parent = await getCommit(cur.parentId);
    if (!parent) throw new Error(`Missing parent commit: ${cur.parentId}`);
    chain.unshift(parent);
    cur = parent;
  }

  const base = chain[0]!;
  let bytes: Uint8Array;
  if (base.storage.kind === 'raw') {
    bytes = base.storage.bytes;
  } else if (base.storage.kind === 'snapshot') {
    bytes = await decompress(base.storage.gz);
  } else {
    throw new Error('Expected snapshot at chain root');
  }

  if (chain.length === 1) return bytes;

  let agsFile = parseStr(decodeBytes(bytes)).file;
  if (!agsFile) throw new Error('Failed to parse snapshot AGS');

  for (let i = 1; i < chain.length; i++) {
    const c = chain[i]!;
    if (c.storage.kind !== 'delta') throw new Error('Expected delta in chain');
    agsFile = applyDelta(agsFile, c.storage.delta);
  }

  return new TextEncoder().encode(serialize(agsFile));
}
