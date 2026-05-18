const REF_PATTERN = /\{\{\s*ref\s*\(\s*(['"])([^'"]+)\1\s*\)\s*\}\}/g;

const SOURCE_PATTERN = /\{\{\s*source\s*\(\s*(['"])([^'"]+)\1\s*\)\s*\}\}/g;

export function extractRefs(sql: string): string[] {
  const names = new Set<string>();
  for (const m of sql.matchAll(REF_PATTERN)) {
    names.add(m[2]!);
  }
  return [...names];
}

export function extractSources(sql: string): string[] {
  const names = new Set<string>();
  for (const m of sql.matchAll(SOURCE_PATTERN)) {
    names.add(m[2]!);
  }
  return [...names];
}

export function resolveRefs(
  sql: string,
  resolveRef: (name: string) => string,
  resolveSource: (name: string) => string = resolveRef,
): string {
  return sql
    .replace(REF_PATTERN, (_full, _q, name: string) => resolveRef(name))
    .replace(SOURCE_PATTERN, (_full, _q, name: string) => resolveSource(name));
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
