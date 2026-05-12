import { AgsFile, AgsType, AgsValue, AgsTypeFunctions } from "../model.js";

/**
 * Serialize an AgsFile back to AGS 4.x text.
 */
export function serialize(file: AgsFile): string {
  let out = "";
  let firstGroup = true;
  for (const name in file.groups) {
    const group = file.groups[name]!;
    if (!firstGroup) {
      out += "\r\n";
    }
    firstGroup = false;

    out += writeRow(["GROUP", name]);
    out += writeRow(["HEADING", ...group.headings.map((h) => h.name)]);
    out += writeRow(["UNIT", ...group.headings.map((h) => h.unit)]);
    out += writeRow(["TYPE", ...group.headings.map((h) => AgsTypeFunctions.toString(h.data_type))]);

    for (const row of group.rows) {
      const data = group.headings.map((h) => valueToString(row[h.name] ?? null, h.data_type));
      out += writeRow(["DATA", ...data]);
    }
  }
  return out;
}

function writeRow(fields: string[]): string {
  return fields.map(writeQuoted).join(",") + "\r\n";
}

function writeQuoted(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function valueToString(v: AgsValue, type: AgsType): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "Y" : "N";
  if (typeof v === "number") return formatNumber(v, type);
  return v;
}

function formatNumber(n: number, type: AgsType): string {
  if (typeof type !== "string") {
    switch (type._tag) {
      case "DP":
        return n.toFixed(type.n);
      case "SF":
        return n.toPrecision(type.n);
      case "SCI":
        return n.toExponential(type.n);
      case "Other":
        break;
    }
  }

  if (Number.isInteger(n) && Math.abs(n) < 1e16 && type !== "RL") {
    return `${n}`;
  }
  return `${n}`;
}
