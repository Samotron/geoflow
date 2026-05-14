import type { AgsRow } from '../core.js';

export function downloadBlob(
  data: Uint8Array | ArrayBuffer | string,
  name: string,
  mime: string,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = new Blob([data as any], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportBaseName(fileName: string | undefined): string {
  return fileName?.replace(/\.[^.]+$/, '') ?? 'file';
}

export function exportDatePrefix(): string {
  return new Date().toISOString().slice(0, 10);
}

export function toCsvRow(headings: string[], row: AgsRow): string {
  return headings
    .map((h) => {
      const v = row[h];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}
