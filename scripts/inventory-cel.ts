import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

const SCAN_DIRS = [
  'rules/specs',
  'examples/rules'
];

function getAllYamlFiles(dir: string): string[] {
  let results: string[] = [];
  if (!lstatSync(dir).isDirectory()) return [];
  const list = readdirSync(dir);
  for (const file of list) {
    const path = join(dir, file);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      results = results.concat(getAllYamlFiles(path));
    } else if (file.endsWith('.yml') || file.endsWith('.yaml')) {
      results.push(path);
    }
  }
  return results;
}

const allFiles = SCAN_DIRS.flatMap(dir => getAllYamlFiles(join(process.cwd(), dir)));

const expressions = new Set<string>();

for (const file of allFiles) {
  try {
    const content = readFileSync(file, 'utf8');
    const doc = YAML.parse(content);
    if (!doc) continue;

    if (Array.isArray(doc.rules)) {
      for (const rule of doc.rules) {
        if (rule.when) expressions.add(rule.when);
        if (rule.expr) expressions.add(rule.expr);
        if (Array.isArray(rule.fix_steps)) {
            for (const step of rule.fix_steps) {
                if (step.value) expressions.add(step.value);
            }
        }
      }
    }
  } catch (err) {
    console.error(`Error parsing ${file}:`, err);
  }
}

console.log(`Found ${expressions.size} unique CEL expressions.`);

// Basic tokenization to find functions and operators
const functions = new Set<string>();
const operators = new Set<string>();

// Simple regex for words followed by '(' for functions
// and common CEL operators
for (const expr of expressions) {
  const funcMatches = expr.matchAll(/([a-z0-9_]+)\s*\(/gi);
  for (const match of funcMatches) {
    functions.add(match[1]);
  }

  const ops = ['==', '!=', '>=', '<=', '>', '<', '&&', '||', '!', ' in ', '\\?', ':', '\\+', '-', '\\*', '/', '%'];
  for (const op of ops) {
    const regex = new RegExp(op, 'g');
    if (regex.test(expr)) {
      operators.add(op.trim());
    }
  }
}

console.log('\nFunctions used:');
console.log(Array.from(functions).sort().join(', '));

console.log('\nOperators used:');
console.log(Array.from(operators).sort().join(', '));

// Also look for macro-like things (map, filter, all, exists)
const macros = ['map', 'filter', 'all', 'exists', 'exists_one'];
const foundMacros = new Set<string>();
for (const expr of expressions) {
    for (const macro of macros) {
        if (new RegExp(`\\.${macro}\\s*\\(`, 'g').test(expr)) {
            foundMacros.add(macro);
        }
    }
}

console.log('\nMacros used:');
console.log(Array.from(foundMacros).sort().join(', '));
