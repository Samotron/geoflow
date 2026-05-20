import { Option } from "effect";
import type { AgsFile, AgsRow, AgsValue } from "./model.js";
import type { Diagnostic} from "./diagnostics.js";
import { DiagnosticBuilder, Severity } from "./diagnostics.js";

// ---- Public types ----

export interface QualityDimension {
  id: string;
  name: string;
  description: string;
  score: number;
  issues: Diagnostic[];
}

export interface QualityReport {
  overall_score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  dimensions: QualityDimension[];
  all_diagnostics: Diagnostic[];
}

// ---- Scoring ----

function scoreFromIssues(issues: Diagnostic[]): number {
  let deduction = 0;
  for (const issue of issues) {
    switch (issue.severity) {
      case Severity.Error:
        deduction += 15;
        break;
      case Severity.Warning:
        deduction += 7;
        break;
      case Severity.Info:
        deduction += 2;
        break;
    }
  }
  return Math.max(0, 100 - deduction);
}

function gradeFromScore(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

// ---- Helpers ----

function textVal(row: AgsRow, heading: string): string | null {
  const v = row[heading];
  return typeof v === "string" ? v : null;
}

function numVal(row: AgsRow, heading: string): number | null {
  const v = row[heading];
  return typeof v === "number" ? v : null;
}

function hasValue(v: AgsValue | undefined): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

// ---- Dimension: Completeness ----

function checkCompleteness(file: AgsFile): Diagnostic[] {
  const issues: Diagnostic[] = [];

  // QUAL-COMP-001: PROJ_NAME populated
  const proj = file.groups.PROJ;
  if (proj) {
    const row = proj.rows[0] ?? {};
    if (!hasValue(row["PROJ_NAME"])) {
      issues.push(
        new DiagnosticBuilder("QUAL-COMP-001", Severity.Warning, "PROJ_NAME is empty or not recorded")
          .atGroup("PROJ")
          .build()
      );
    }
  }

  // QUAL-COMP-002: PROJ_LOC populated
  if (proj) {
    const row = proj.rows[0] ?? {};
    if (!hasValue(row["PROJ_LOC"])) {
      issues.push(
        new DiagnosticBuilder("QUAL-COMP-002", Severity.Info, "PROJ_LOC (project location) is empty or not recorded")
          .atGroup("PROJ")
          .build()
      );
    }
  }

  // QUAL-COMP-003: TRAN_DATE populated
  const tran = file.groups.TRAN;
  if (tran) {
    const row = tran.rows[0] ?? {};
    if (!hasValue(row["TRAN_DATE"])) {
      issues.push(
        new DiagnosticBuilder("QUAL-COMP-003", Severity.Info, "TRAN_DATE (transfer date) is empty or not recorded")
          .atGroup("TRAN")
          .build()
      );
    }
  }

  // QUAL-COMP-004: LOCA_FDEP per LOCA row
  const loca = file.groups.LOCA;
  if (loca) {
    for (let i = 0; i < loca.rows.length; i++) {
      const row = loca.rows[i]!;
      const locaId = textVal(row, "LOCA_ID") ?? `row ${i + 1}`;
      if (!hasValue(row["LOCA_FDEP"])) {
        issues.push(
          new DiagnosticBuilder(
            "QUAL-COMP-004",
            Severity.Warning,
            `LOCA "${locaId}": LOCA_FDEP (final depth) not recorded`
          )
            .atGroup("LOCA")
            .build()
        );
      }
    }
  }

  // QUAL-COMP-005: Coordinates per LOCA row
  if (loca) {
    const headingNames = new Set(loca.headings.map((h) => h.name));
    const hasGridCols = headingNames.has("LOCA_NATE") && headingNames.has("LOCA_NATN");
    const hasLatLonCols = headingNames.has("LOCA_LAT") && headingNames.has("LOCA_LON");

    if (!hasGridCols && !hasLatLonCols) {
      issues.push(
        new DiagnosticBuilder(
          "QUAL-COMP-005",
          Severity.Warning,
          "LOCA group has no coordinate columns (expected LOCA_NATE/LOCA_NATN or LOCA_LAT/LOCA_LON)"
        )
          .atGroup("LOCA")
          .build()
      );
    } else {
      for (let i = 0; i < loca.rows.length; i++) {
        const row = loca.rows[i]!;
        const locaId = textVal(row, "LOCA_ID") ?? `row ${i + 1}`;
        const hasGrid = hasGridCols && hasValue(row["LOCA_NATE"]) && hasValue(row["LOCA_NATN"]);
        const hasLatLon = hasLatLonCols && hasValue(row["LOCA_LAT"]) && hasValue(row["LOCA_LON"]);
        if (!hasGrid && !hasLatLon) {
          issues.push(
            new DiagnosticBuilder("QUAL-COMP-005", Severity.Warning, `LOCA "${locaId}": no coordinates recorded`)
              .atGroup("LOCA")
              .build()
          );
        }
      }
    }
  }

  // QUAL-COMP-006: GEOL_DESC per GEOL row
  const geol = file.groups.GEOL;
  if (geol) {
    for (let i = 0; i < geol.rows.length; i++) {
      const row = geol.rows[i]!;
      const locaId = textVal(row, "LOCA_ID") ?? "?";
      const top = row["GEOL_TOP"] ?? "?";
      if (!hasValue(row["GEOL_DESC"])) {
        issues.push(
          new DiagnosticBuilder(
            "QUAL-COMP-006",
            Severity.Warning,
            `GEOL "${locaId}" at ${top}m: GEOL_DESC is empty`
          )
            .atGroup("GEOL")
            .build()
        );
      }
    }
  }

  return issues;
}

// ---- Dimension: Description Quality ----

function checkDescriptions(file: AgsFile): Diagnostic[] {
  const issues: Diagnostic[] = [];

  // QUAL-DESC-001: GEOL_DESC too short (< 5 chars)
  const geol = file.groups.GEOL;
  if (geol) {
    for (let i = 0; i < geol.rows.length; i++) {
      const row = geol.rows[i]!;
      const locaId = textVal(row, "LOCA_ID") ?? "?";
      const top = row["GEOL_TOP"] ?? "?";
      const desc = textVal(row, "GEOL_DESC");
      if (desc !== null && desc.trim().length > 0 && desc.trim().length < 5) {
        issues.push(
          new DiagnosticBuilder(
            "QUAL-DESC-001",
            Severity.Warning,
            `GEOL "${locaId}" at ${top}m: GEOL_DESC "${desc}" is suspiciously short (< 5 chars)`
          )
            .atGroup("GEOL")
            .build()
        );
      }
    }
  }

  // QUAL-DESC-002: ABBR_DESC empty or too short (< 3 chars)
  const abbr = file.groups.ABBR;
  if (abbr) {
    for (let i = 0; i < abbr.rows.length; i++) {
      const row = abbr.rows[i]!;
      const code = textVal(row, "ABBR_CODE") ?? `row ${i + 1}`;
      const desc = textVal(row, "ABBR_DESC");
      if (!desc || desc.trim().length < 3) {
        issues.push(
          new DiagnosticBuilder(
            "QUAL-DESC-002",
            Severity.Info,
            `ABBR code "${code}": description is empty or very short (< 3 chars)`
          )
            .atGroup("ABBR")
            .build()
        );
      }
    }
  }

  // QUAL-DESC-003: SAMP_TYPE blank where column is declared
  const samp = file.groups.SAMP;
  if (samp && samp.headings.some((h) => h.name === "SAMP_TYPE")) {
    for (let i = 0; i < samp.rows.length; i++) {
      const row = samp.rows[i]!;
      const locaId = textVal(row, "LOCA_ID") ?? "?";
      const top = row["SAMP_TOP"] ?? "?";
      if (!hasValue(row["SAMP_TYPE"])) {
        issues.push(
          new DiagnosticBuilder(
            "QUAL-DESC-003",
            Severity.Warning,
            `SAMP "${locaId}" at ${top}m: SAMP_TYPE is blank`
          )
            .atGroup("SAMP")
            .build()
        );
      }
    }
  }

  return issues;
}

// ---- Dimension: Value Ranges ----

function checkRanges(file: AgsFile): Diagnostic[] {
  const issues: Diagnostic[] = [];

  // QUAL-RANGE-001: ISPT_NVAL plausibility (must be 0–150)
  const ispt = file.groups.ISPT;
  if (ispt) {
    for (let i = 0; i < ispt.rows.length; i++) {
      const row = ispt.rows[i]!;
      const locaId = textVal(row, "LOCA_ID") ?? "?";
      const top = row["ISPT_TOP"] ?? "?";
      const nval = numVal(row, "ISPT_NVAL");
      if (nval !== null) {
        if (nval < 0) {
          issues.push(
            new DiagnosticBuilder(
              "QUAL-RANGE-001",
              Severity.Error,
              `ISPT "${locaId}" at ${top}m: ISPT_NVAL ${nval} is negative`
            )
              .atGroup("ISPT")
              .build()
          );
        } else if (nval > 150) {
          issues.push(
            new DiagnosticBuilder(
              "QUAL-RANGE-001",
              Severity.Warning,
              `ISPT "${locaId}" at ${top}m: ISPT_NVAL ${nval} is unusually high (> 150)`
            )
              .atGroup("ISPT")
              .build()
          );
        }
      }
    }
  }

  // QUAL-RANGE-002: Negative depth values
  const depthChecks: Array<[string, string[]]> = [
    ["LOCA", ["LOCA_FDEP", "LOCA_GL"]],
    ["GEOL", ["GEOL_TOP", "GEOL_BASE"]],
    ["SAMP", ["SAMP_TOP", "SAMP_BASE"]],
    ["ISPT", ["ISPT_TOP", "ISPT_DPTH"]],
    ["WSTK", ["WSTK_DPTH"]],
    ["HOLE", ["HOLE_DPTH"]],
    ["CDIA", ["CDIA_DPTH"]],
  ];

  for (const [groupName, depthHeadings] of depthChecks) {
    const group = file.groups[groupName];
    if (!group) continue;
    for (let i = 0; i < group.rows.length; i++) {
      const row = group.rows[i]!;
      const locaId = textVal(row, "LOCA_ID") ?? "?";
      for (const heading of depthHeadings) {
        const v = numVal(row, heading);
        if (v !== null && v < 0) {
          issues.push(
            new DiagnosticBuilder(
              "QUAL-RANGE-002",
              Severity.Warning,
              `${groupName} "${locaId}": ${heading} = ${v} is negative`
            )
              .atGroup(groupName)
              .build()
          );
        }
      }
    }
  }

  // QUAL-RANGE-003: LOCA_FDEP shallower than deepest recorded data
  const loca = file.groups.LOCA;
  if (loca) {
    const deepestByLoca = new Map<string, number>();

    for (const [groupName, depthKey] of [["GEOL", "GEOL_BASE"], ["SAMP", "SAMP_TOP"]] as const) {
      const group = file.groups[groupName];
      if (!group) continue;
      for (const row of group.rows) {
        const id = String(row["LOCA_ID"] ?? "");
        const v = numVal(row, depthKey);
        if (id && v !== null) {
          deepestByLoca.set(id, Math.max(deepestByLoca.get(id) ?? 0, v));
        }
      }
    }

    for (const row of loca.rows) {
      const id = String(row["LOCA_ID"] ?? "");
      const fdep = numVal(row, "LOCA_FDEP");
      if (fdep !== null && id) {
        const deepest = deepestByLoca.get(id) ?? 0;
        if (deepest > fdep + 0.01) {
          issues.push(
            new DiagnosticBuilder(
              "QUAL-RANGE-003",
              Severity.Warning,
              `LOCA "${id}": LOCA_FDEP (${fdep}m) is shallower than deepest recorded data (${deepest}m)`
            )
              .atGroup("LOCA")
              .build()
          );
        }
      }
    }
  }

  return issues;
}

// ---- Dimension: Stratigraphic Consistency ----

function checkStratigraphy(file: AgsFile): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const geol = file.groups.GEOL;
  if (!geol) return issues;

  const byLocation = new Map<string, Array<{ top: number; base: number }>>();
  for (const row of geol.rows) {
    const id = String(row["LOCA_ID"] ?? "");
    const top = numVal(row, "GEOL_TOP");
    const base = numVal(row, "GEOL_BASE");
    if (!id || top === null || base === null) continue;
    if (!byLocation.has(id)) byLocation.set(id, []);
    byLocation.get(id)!.push({ top, base });
  }

  for (const [locaId, layers] of byLocation) {
    const sorted = [...layers].sort((a, b) => a.top - b.top);

    // QUAL-STRAT-001: gaps between consecutive layers
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      const gap = curr.top - prev.base;
      if (gap > 0.01) {
        issues.push(
          new DiagnosticBuilder(
            "QUAL-STRAT-001",
            Severity.Warning,
            `GEOL "${locaId}": uncharacterized gap between ${prev.base}m and ${curr.top}m (${gap.toFixed(2)}m)`
          )
            .atGroup("GEOL")
            .build()
        );
      }
    }

    // QUAL-STRAT-002: deepest GEOL_BASE vs. LOCA_FDEP
    const deepestBase = sorted.length > 0 ? sorted[sorted.length - 1]!.base : null;
    const locaRow = file.groups.LOCA?.rows.find((r) => String(r["LOCA_ID"] ?? "") === locaId);
    if (locaRow && deepestBase !== null) {
      const fdep = numVal(locaRow, "LOCA_FDEP");
      if (fdep !== null) {
        const discrepancy = Math.abs(fdep - deepestBase);
        if (discrepancy > 0.5) {
          issues.push(
            new DiagnosticBuilder(
              "QUAL-STRAT-002",
              Severity.Info,
              `GEOL "${locaId}": deepest GEOL_BASE (${deepestBase}m) differs from LOCA_FDEP (${fdep}m) by ${discrepancy.toFixed(2)}m`
            )
              .atGroup("GEOL")
              .build()
          );
        }
      }
    }
  }

  return issues;
}

// ---- Dimension: Coverage ----

function checkCoverage(file: AgsFile): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const loca = file.groups.LOCA;
  if (!loca) return issues;

  const locaIds = new Set<string>();
  for (const row of loca.rows) {
    const id = String(row["LOCA_ID"] ?? "");
    if (id) locaIds.add(id);
  }

  const geolIds = new Set<string>();
  for (const row of file.groups.GEOL?.rows ?? []) {
    const id = String(row["LOCA_ID"] ?? "");
    if (id) geolIds.add(id);
  }

  const sampIds = new Set<string>();
  for (const row of file.groups.SAMP?.rows ?? []) {
    const id = String(row["LOCA_ID"] ?? "");
    if (id) sampIds.add(id);
  }

  const testGroupNames = ["ISPT", "WSTK", "HOLE", "CDIA", "CHLG", "CPTU", "CPTG", "LLPL", "LDEN", "LPDN", "LPEN", "LTRT"];

  for (const locaId of locaIds) {
    // QUAL-COV-001: no geology records
    if (!geolIds.has(locaId)) {
      issues.push(
        new DiagnosticBuilder("QUAL-COV-001", Severity.Warning, `LOCA "${locaId}": no GEOL (geology) records`)
          .atGroup("LOCA")
          .build()
      );
    }

    // QUAL-COV-002: no samples or test records
    if (!sampIds.has(locaId)) {
      const hasAnyTest = testGroupNames.some((gName) =>
        file.groups[gName]?.rows.some((r) => String(r["LOCA_ID"] ?? "") === locaId)
      );
      if (!hasAnyTest) {
        issues.push(
          new DiagnosticBuilder("QUAL-COV-002", Severity.Info, `LOCA "${locaId}": no samples (SAMP) or test records`)
            .atGroup("LOCA")
            .build()
        );
      }
    }
  }

  return issues;
}

// ---- Dimension registry ----

interface DimDef {
  id: string;
  name: string;
  description: string;
  weight: number;
  fn: (file: AgsFile) => Diagnostic[];
}

const DIMENSIONS: DimDef[] = [
  {
    id: "completeness",
    name: "Completeness",
    description: "Key metadata and measurement fields are populated",
    weight: 30,
    fn: checkCompleteness,
  },
  {
    id: "descriptions",
    name: "Descriptions",
    description: "Text descriptions are meaningful and sufficiently detailed",
    weight: 20,
    fn: checkDescriptions,
  },
  {
    id: "ranges",
    name: "Value Ranges",
    description: "Numeric values are within expected geotechnical bounds",
    weight: 25,
    fn: checkRanges,
  },
  {
    id: "stratigraphy",
    name: "Stratigraphy",
    description: "Geology layers are continuous and consistent with borehole depth",
    weight: 15,
    fn: checkStratigraphy,
  },
  {
    id: "coverage",
    name: "Coverage",
    description: "Each location has expected data groups recorded",
    weight: 10,
    fn: checkCoverage,
  },
];

// ---- Public API ----

export function assessQuality(file: AgsFile): QualityReport {
  const dimensions: QualityDimension[] = [];
  const allDiagnostics: Diagnostic[] = [];

  let totalWeight = 0;
  let weightedScore = 0;

  for (const dim of DIMENSIONS) {
    const issues = dim.fn(file);
    const score = scoreFromIssues(issues);

    dimensions.push({
      id: dim.id,
      name: dim.name,
      description: dim.description,
      score,
      issues,
    });

    allDiagnostics.push(...issues);
    weightedScore += score * dim.weight;
    totalWeight += dim.weight;
  }

  const overallScore = Math.round(totalWeight > 0 ? weightedScore / totalWeight : 100);

  return {
    overall_score: overallScore,
    grade: gradeFromScore(overallScore),
    dimensions,
    all_diagnostics: allDiagnostics,
  };
}

export function renderQualityText(report: QualityReport, filePath?: string): string {
  const header = filePath ? `Quality Report — ${filePath}` : "Quality Report";
  let out = `${header}\n${"=".repeat(header.length)}\n`;
  out += `Overall score: ${report.overall_score}/100 (${report.grade})\n\n`;

  const nameWidth = Math.max(...report.dimensions.map((d) => d.name.length));
  for (const dim of report.dimensions) {
    const bar = progressBar(dim.score, 20);
    const issueStr = dim.issues.length === 1 ? "1 issue" : `${dim.issues.length} issues`;
    out += `  ${dim.name.padEnd(nameWidth)}  [${bar}] ${String(dim.score).padStart(3)}/100  ${issueStr}\n`;
  }

  if (report.all_diagnostics.length > 0) {
    out += `\nIssues (${report.all_diagnostics.length} total):\n`;
    for (const diag of report.all_diagnostics) {
      const loc = fmtLoc(diag);
      out += `  ${diag.severity}: [${diag.rule_id}] ${diag.message}${loc}\n`;
    }
  } else {
    out += "\nNo issues found.\n";
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of report.all_diagnostics) {
    if (d.severity === Severity.Error) counts.error++;
    else if (d.severity === Severity.Warning) counts.warning++;
    else counts.info++;
  }
  out += `\nsummary: ${counts.error} error, ${counts.warning} warning, ${counts.info} info\n`;

  return out;
}

export function renderQualityJson(report: QualityReport): string {
  return (
    JSON.stringify(
      {
        overall_score: report.overall_score,
        grade: report.grade,
        dimensions: report.dimensions.map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description,
          score: d.score,
          issue_count: d.issues.length,
          issues: d.issues.map((diag) => ({
            rule_id: diag.rule_id,
            severity: diag.severity,
            message: diag.message,
            group: Option.getOrNull(diag.location.group),
          })),
        })),
      },
      null,
      2
    ) + "\n"
  );
}

function progressBar(score: number, width: number): string {
  const filled = Math.round((score / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtLoc(diag: Diagnostic): string {
  const parts: string[] = [];
  if (diag.location.group._tag === "Some") parts.push(`group=${diag.location.group.value}`);
  if (diag.location.line._tag === "Some") parts.push(`line=${diag.location.line.value}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}
