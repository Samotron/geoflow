import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const RUST_BIN = join(process.cwd(), 'target/debug/geoflow');
const FIXTURES_AGS_DIR = join(process.cwd(), 'tests/fixtures/ags');
const FIXTURES_DIGGS_DIR = join(process.cwd(), 'tests/fixtures/diggs');
const BASELINE_ROOT = join(process.cwd(), 'tests/parity/baselines');

const AGS_FIXTURES = readdirSync(FIXTURES_AGS_DIR)
  .filter(f => f.endsWith('.ags'))
  .map(f => join(FIXTURES_AGS_DIR, f));

const DIGGS_FIXTURES = readdirSync(FIXTURES_DIGGS_DIR)
  .filter(f => f.endsWith('.diggs'))
  .map(f => join(FIXTURES_DIGGS_DIR, f));

function capture(cmd: string, args: string[], outputArtifacts: { [name: string]: string } = {}) {
  // If first arg is a file path, use its basename as the subdirectory
  let subDir = 'default';
  if (args.length > 0) {
    if (args[0].includes('/') || args[0].includes('\\')) {
      subDir = basename(args[0]);
    } else {
      subDir = args[0];
    }
  }
  
  const base = args.slice(1).join('_').replace(/[^a-z0-9]/gi, '_');
  const outputDir = join(BASELINE_ROOT, cmd, subDir);
  mkdirSync(outputDir, { recursive: true });

  const commandLine = `${RUST_BIN} ${cmd} ${args.map(a => `"${a}"`).join(' ')}`;
  console.log(`Capturing: ${cmd} ${args.join(' ')}`);

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    stdout = execSync(commandLine, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    stdout = e.stdout || '';
    stderr = e.stderr || '';
    exitCode = e.status ?? 1;
  }

  const filePrefix = base ? `${base}_` : '';
  writeFileSync(join(outputDir, `${filePrefix}stdout.txt`), stdout);
  writeFileSync(join(outputDir, `${filePrefix}stderr.txt`), stderr);
  writeFileSync(join(outputDir, `${filePrefix}exit.txt`), exitCode.toString());

  if (Object.keys(outputArtifacts).length > 0) {
    const artifactsDir = join(outputDir, `${filePrefix}artifacts`);
    mkdirSync(artifactsDir, { recursive: true });
    for (const [name, path] of Object.entries(outputArtifacts)) {
      if (existsSync(path)) {
        copyFileSync(path, join(artifactsDir, name));
      }
    }
  }
}

function captureRulePackDiagnostics() {
  const packs = [
    'rules/specs/ags/standard/4.x/pack.yml',
    'rules/specs/ice/mini/0.1/pack.yml',
    'examples/rules/ice_mini.yml'
  ].filter(p => existsSync(join(process.cwd(), p)));

  const results: Record<string, Record<string, unknown>> = {};

  for (const pack of packs) {
    results[pack] = {};
    for (const f of AGS_FIXTURES) {
      const fixtureName = basename(f);
      console.log(`Capturing rule pack diagnostics: ${pack} on ${fixtureName}`);
      try {
        const stdout = execSync(`${RUST_BIN} validate "${f}" --rules "${pack}" --format json`, { encoding: 'utf8' });
        results[pack]![fixtureName] = JSON.parse(stdout);
      } catch (err) {
        const e = err as { message?: string; stdout?: string };
        results[pack]![fixtureName] = { error: e.message, stdout: e.stdout };
      }
    }
  }

  const rulesBaselinePath = join(process.cwd(), 'tests/parity/rules');
  mkdirSync(rulesBaselinePath, { recursive: true });
  writeFileSync(join(rulesBaselinePath, 'baselines.json'), JSON.stringify(results, null, 2));
}

async function main() {
  console.log('Starting baseline capture...');

  if (existsSync(BASELINE_ROOT)) rmSync(BASELINE_ROOT, { recursive: true, force: true });
  mkdirSync(BASELINE_ROOT, { recursive: true });

  // 1. Info
  for (const f of AGS_FIXTURES) {
    capture('info', [f]);
  }

  // 2. Validate
  for (const f of AGS_FIXTURES) {
    capture('validate', [f]);
    capture('validate', [f, '--format', 'json']);
  }

  // 3. Fix
  for (const f of AGS_FIXTURES) {
    const diffFile = join(process.cwd(), 'temp_diff.json');
    const fixedFile = join(process.cwd(), 'temp_fixed.ags');
    // We use a copy to avoid mutating the fixture if we used --write
    copyFileSync(f, fixedFile);
    capture('fix', [fixedFile, '--write', '--diff-file', diffFile], { 
        'diff.json': diffFile,
        'fixed.ags': fixedFile
    });
    if (existsSync(diffFile)) rmSync(diffFile);
    if (existsSync(fixedFile)) rmSync(fixedFile);
  }

  // 4. Convert AGS -> DIGGS
  for (const f of AGS_FIXTURES) {
    const outFile = join(process.cwd(), 'temp_out.diggs');
    capture('convert', [f, outFile, '--to', 'diggs'], { 'output.diggs': outFile });
    if (existsSync(outFile)) rmSync(outFile);
  }

  // 5. Convert DIGGS -> AGS
  for (const f of DIGGS_FIXTURES) {
    const outFile = join(process.cwd(), 'temp_out.ags');
    capture('convert', [f, outFile, '--to', 'ags'], { 'output.ags': outFile });
    if (existsSync(outFile)) rmSync(outFile);
  }

  // 6. Diff
  if (AGS_FIXTURES.length >= 2) {
      capture('diff', [AGS_FIXTURES[0], AGS_FIXTURES[1]]);
      capture('diff', [AGS_FIXTURES[0], AGS_FIXTURES[1], '--format', 'json']);
  }

  // 7. Explore (static export)
  if (AGS_FIXTURES.length > 0) {
      const exploreOut = join(process.cwd(), 'temp_explore');
      if (existsSync(exploreOut)) rmSync(exploreOut, { recursive: true });
      mkdirSync(exploreOut);
      capture('explore', [AGS_FIXTURES[0], '--out', exploreOut]);
      // Capture index.html if it exists
      if (existsSync(join(exploreOut, 'index.html'))) {
          const exploreDir = join(BASELINE_ROOT, 'explore', basename(AGS_FIXTURES[0]));
          mkdirSync(join(exploreDir, 'artifacts'), { recursive: true });
          copyFileSync(join(exploreOut, 'index.html'), join(exploreDir, 'artifacts', 'index.html'));
      }
      rmSync(exploreOut, { recursive: true });
  }

  // 8. DB commands
  const dbPath = join(process.cwd(), 'temp.gpkg');
  if (existsSync(dbPath)) rmSync(dbPath);
  capture('db', ['init', '--path', dbPath], { 'init.gpkg': dbPath });
  
  if (AGS_FIXTURES.length > 0) {
      capture('db', ['import', AGS_FIXTURES[0], '--db', dbPath]);
      capture('db', ['query', '--db', dbPath, '--format', 'json']);
  }
  if (existsSync(dbPath)) rmSync(dbPath);

  // 9. Rules list/show
  capture('rules', ['list']);
  capture('rules', ['show', 'AGS-STRUCT-001']);

  // 10. Describe
  capture('describe', ['Soft grey CLAY']);
  capture('describe', ['Soft grey CLAY', '--format', 'json']);

  // 11. Capture rule-pack diagnostics
  captureRulePackDiagnostics();

  console.log('Baseline capture complete.');
}

main().catch(console.error);
