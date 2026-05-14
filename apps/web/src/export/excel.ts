import * as XLSX from 'xlsx';
import type { AgsFile } from '../core.js';
import { downloadBlob, exportBaseName, exportDatePrefix } from './utils.js';

export async function exportExcel(agsFile: AgsFile, fileName: string | undefined): Promise<void> {
  const date = exportDatePrefix();
  const base = exportBaseName(fileName);
  const wb = XLSX.utils.book_new();

  // ── Summary sheet ──────────────────────────────────────────────────────────
  const groups = Object.entries(agsFile.groups).filter(([, g]) => g != null);
  const summaryRows: (string | number)[][] = [
    ['GeoFlow Export'],
    [],
    ['Source file', fileName ?? 'unknown'],
    ['Export date', date],
    ['AGS version', agsFile.ags_version ?? 'unknown'],
    ['Groups', groups.length],
    [],
    ['Group', 'Rows', 'Columns'],
    ...groups.map(([name, g]) => [name, g!.rows.length, g!.headings.length]),
  ];
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryRows);
  summaryWs['!cols'] = [{ wch: 18 }, { wch: 36 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, summaryWs, '_Summary');

  // ── One sheet per group ────────────────────────────────────────────────────
  for (const [groupName, group] of groups) {
    if (!group) continue;

    const headingRow = group.headings.map((h) => h.name);
    const unitRow = group.headings.map((h) => h.unit || '–');
    const dataRows = group.rows.map((row) =>
      group.headings.map((h) => {
        const v = row[h.name];
        return v === null || v === undefined ? '' : v;
      }),
    );

    const ws = XLSX.utils.aoa_to_sheet([headingRow, unitRow, ...dataRows]);

    // Freeze the two header rows
    ws['!freeze'] = { xSplit: 0, ySplit: 2 };

    // Auto-size columns to the wider of heading name or 12 chars
    ws['!cols'] = headingRow.map((h) => ({ wch: Math.max(h.length + 2, 12) }));

    // Excel sheet names are max 31 chars and can't contain []*?:/\
    const safeName = groupName.replace(/[\[\]*?:/\\]/g, '_').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, safeName);
  }

  const bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  downloadBlob(
    bytes,
    `${date}-${base}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
}
