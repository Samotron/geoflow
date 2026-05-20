import { Option } from "effect";
import type { AgsFile } from "./model.js";
import type { Diagnostic, Severity } from "./diagnostics.js";
import { standardRules } from "./validate.rules.js";

/**
 * A built-in validation rule.
 */
export interface Rule {
  /** Stable identifier (e.g. `AGS-RULE-1`). */
  readonly id: string;
  /** One-line human description. */
  readonly description: string;
  /** Default severity when this rule fires. */
  readonly default_severity: Severity;
  /** Run the rule and append zero or more diagnostics. */
  check(file: AgsFile, diagnostics: Diagnostic[]): void;
  /** The `geoflow fix` fix name that resolves diagnostics from this rule, if one exists. */
  readonly fixable_by?: string;
}

export interface RuleInfo {
  id: string;
  description: string;
  severity: Severity;
}

/**
 * Registry of built-in rules.
 */
export class Registry {
  private rules: Rule[] = [];

  static standard(): Registry {
    const registry = new Registry();
    for (const rule of standardRules()) {
      registry.addRule(rule);
    }
    return registry;
  }

  addRule(rule: Rule) {
    this.rules.push(rule);
  }

  allRules(): RuleInfo[] {
    return this.rules.map((r) => ({
      id: r.id,
      description: r.description,
      severity: r.default_severity,
    }));
  }

  getRules(): readonly Rule[] {
    return this.rules;
  }

  find(id: string): RuleInfo | undefined {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return undefined;
    return { id: rule.id, description: rule.description, severity: rule.default_severity };
  }
}

/**
 * Run every rule in the registry against `file`.
 */
export function validate(file: AgsFile, registry: Registry): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const rule of registry.getRules()) {
    const before = diagnostics.length;
    rule.check(file, diagnostics);
    if (rule.fixable_by) {
      for (let i = before; i < diagnostics.length; i++) {
        diagnostics[i]!.fix_id = Option.some(rule.fixable_by);
      }
    }
  }
  return diagnostics;
}
