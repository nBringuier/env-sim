#!/usr/bin/env node
/**
 * generate-coverage.mjs
 *
 * Converts Chrome DevTools Coverage JSON exports into a human-readable
 * HTML report mapped back to TypeScript sources, including files that
 * were never loaded (0% coverage).
 *
 * Usage:
 *   node generate-coverage.mjs [options]
 *
 * Options:
 *   --input   <glob>   Glob for V8 JSON files        (default: "./coverage-sessions/*.json")
 *   --dist    <path>   Angular build output folder    (default: "./dist/app-angular/browser")
 *   --output  <path>   Where to write HTML report     (default: "./coverage-report")
 *   --src     <path>   Source root folder to scan     (default: "./src")
 */

import fs   from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : fallback;
}

const INPUT_GLOB = getArg('--input',  './coverage-sessions/*.json');
const DIST_DIR   = path.resolve(getArg('--dist',   './dist/app-angular/browser'));
const OUTPUT_DIR = path.resolve(getArg('--output', './coverage-report'));
const SRC_DIR    = path.resolve(getArg('--src',    './src'));
const SRC_PREFIX = path.relative(process.cwd(), SRC_DIR).replace(/\\/g, '/') + '/'; // e.g. "src/"
const NYC_OUTPUT = path.join(OUTPUT_DIR, '.nyc_output');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`\x1b[36m[coverage]\x1b[0m ${msg}`); }
function ok(msg)   { console.log(`\x1b[32m[coverage]\x1b[0m ✔ ${msg}`); }
function warn(msg) { console.log(`\x1b[33m[coverage]\x1b[0m ⚠ ${msg}`); }
function die(msg)  { console.error(`\x1b[31m[coverage]\x1b[0m ✖ ${msg}`); process.exit(1); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function resolveGlob(pattern) {
  const dir  = path.resolve(path.dirname(pattern));
  const base = path.basename(pattern);
  const rx   = new RegExp('^' + base.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => rx.test(f))
    .map(f => path.join(dir, f));
}

/**
 * Chrome DevTools exports: { url, ranges: [{start, end}], text }
 * v8-to-istanbul expects:  functions: [{functionName, isBlockCoverage, ranges: [{startOffset, endOffset, count}]}]
 *
 * We convert Chrome's covered-ranges into V8 blocks format by filling the
 * gaps between covered ranges with count=0.
 */
function chromeEntryToV8Blocks(entry) {
  const totalLength = entry.text.length;
  const covered     = entry.ranges; // sorted [{start, end}]
  const allRanges   = [];
  let cursor = 0;

  for (const { start, end } of covered) {
    if (start > cursor) {
      allRanges.push({ startOffset: cursor, endOffset: start, count: 0 });
    }
    allRanges.push({ startOffset: start, endOffset: end, count: 1 });
    cursor = end;
  }
  if (cursor < totalLength) {
    allRanges.push({ startOffset: cursor, endOffset: totalLength, count: 0 });
  }

  return [{ functionName: '(top-level)', isBlockCoverage: true, ranges: allRanges }];
}

/**
 * Recursively find all .ts source files (excluding .spec.ts and .d.ts).
 * Returns absolute paths.
 */
function findAllTsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAllTsFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Build a zero-coverage Istanbul entry for a TypeScript file.
 * One "statement" per non-blank line so the HTML report highlights
 * every uncovered line in red.
 */
function buildZeroEntry(absolutePath, relativeKey) {
  const content     = fs.readFileSync(absolutePath, 'utf8');
  const lines       = content.split('\n');
  const statementMap = {};
  const s            = {};
  let idx = 0;

  lines.forEach((line, lineNum) => {
    if (line.trim().length === 0) return; // skip blank lines
    statementMap[idx] = {
      start: { line: lineNum + 1, column: 0 },
      end:   { line: lineNum + 1, column: line.length },
    };
    s[idx] = 0;
    idx++;
  });

  return {
    path:        relativeKey,
    statementMap,
    fnMap:       {},
    branchMap:   {},
    s,
    f:           {},
    b:           {},
  };
}

// ─── Step 0 – dependency check ───────────────────────────────────────────────

log('Checking dependencies…');
const NEEDED = ['v8-to-istanbul', '@bcoe/v8-coverage', 'nyc'];
const missing = NEEDED.filter(pkg => {
  try { require.resolve(pkg); return false; } catch { return true; }
});
if (missing.length) {
  log(`Installing missing packages: ${missing.join(', ')}`);
  execSync(`npm install --save-dev ${missing.join(' ')}`, { stdio: 'inherit' });
}
ok('Dependencies ready');

const { mergeProcessCovs } = await import('@bcoe/v8-coverage');
const v8toIstanbul          = (await import('v8-to-istanbul')).default;

// ─── Step 1 – locate input files ────────────────────────────────────────────

const inputFiles = resolveGlob(INPUT_GLOB);
if (!inputFiles.length) die(`No JSON files found matching: ${INPUT_GLOB}`);
log(`Found ${inputFiles.length} session file(s):`);
inputFiles.forEach(f => log(`  • ${path.relative(process.cwd(), f)}`));

// ─── Step 2 – load & merge sessions ─────────────────────────────────────────

log('Merging sessions…');

const allSessions = inputFiles.map(f => {
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  return Array.isArray(raw) ? { result: raw } : raw;
});

const merged = allSessions.length === 1
  ? allSessions[0].result
  : mergeProcessCovs(allSessions).result;

const jsEntries = merged.filter(e =>
  e.url.endsWith('.js') && e.text && e.text.length > 100
);

ok(`Merged ${inputFiles.length} session(s) → ${jsEntries.length} JS bundle(s)`);

// ─── Step 3 – convert Chrome format → Istanbul ───────────────────────────────

log('Converting Chrome coverage → Istanbul format (applying source maps)…');

ensureDir(NYC_OUTPUT);

// Track which .ts files were mapped (so we can add the missing ones later)
const coveredTsFiles = new Set(); // relative keys like "src/app/foo.component.ts"
let convertedCount = 0;

for (const entry of jsEntries) {
  const bundleName = path.basename(new URL(entry.url).pathname);
  const bundlePath = path.join(DIST_DIR, bundleName);

  if (!fs.existsSync(bundlePath)) {
    warn(`Bundle not found in dist, skipping: ${bundleName}  (looked in ${DIST_DIR})`);
    continue;
  }
  if (!fs.existsSync(bundlePath + '.map')) {
    warn(`Source map not found, skipping: ${bundleName}.map`);
    continue;
  }

  const blocks = chromeEntryToV8Blocks(entry);

  try {
    const converter = v8toIstanbul(bundlePath);
    await converter.load();
    converter.applyCoverage(blocks);

    const istanbulData = converter.toIstanbul();

    for (const [filePath, data] of Object.entries(istanbulData)) {
      const normalised = filePath.replace(/\\/g, '/');
      if (!normalised.includes(SRC_PREFIX)) continue;

      const relKey = normalised.slice(normalised.indexOf(SRC_PREFIX));
      data.path    = relKey;
      coveredTsFiles.add(relKey);

      const outFile = path.join(NYC_OUTPUT, `${bundleName}-${convertedCount}.json`);
      fs.writeFileSync(outFile, JSON.stringify({ [relKey]: data }, null, 2));
      convertedCount++;
    }

    ok(`Converted: ${bundleName} (${Object.keys(istanbulData).length} source files found)`);
  } catch (err) {
    warn(`Failed to convert ${bundleName}: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
  }
}

if (convertedCount === 0) {
  die(
    'No Istanbul data was produced.\n' +
    '  • Check that --dist points to your Angular build output\n' +
    '  • Make sure .js.map files exist alongside the .js files\n' +
    '  • Run with DEBUG=1 for full stack traces'
  );
}

ok(`${convertedCount} source file(s) mapped from bundles`);

// ─── Step 4 – add zero-coverage entries for never-loaded files ───────────────

log(`Scanning ${SRC_DIR} for TypeScript files not present in any bundle…`);

const allTsFiles  = findAllTsFiles(SRC_DIR);
let zeroCount = 0;

for (const absPath of allTsFiles) {
  const relKey = path.relative(process.cwd(), absPath).replace(/\\/g, '/');

  if (coveredTsFiles.has(relKey)) continue; // already in the report

  const zeroEntry = buildZeroEntry(absPath, relKey);
  const outFile   = path.join(NYC_OUTPUT, `zero-${zeroCount}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ [relKey]: zeroEntry }, null, 2));
  zeroCount++;
}

if (zeroCount > 0) {
  ok(`Added ${zeroCount} file(s) with 0% coverage (never loaded by the browser)`);
} else {
  log('All source files were present in at least one bundle — nothing to add.');
}

// ─── Step 5 – generate HTML report via nyc ───────────────────────────────────

log('Generating HTML report…');

const nycBin = path.resolve(__dirname, 'node_modules/.bin/nyc');
const nycCmd = [
  `"${nycBin}"`,
  'report',
  '--reporter=html',
  '--reporter=text-summary',
  `--report-dir="${OUTPUT_DIR}"`,
  `--temp-dir="${NYC_OUTPUT}"`,
].join(' ');

try {
  execSync(nycCmd, { stdio: 'inherit', cwd: __dirname });
} catch {
  // nyc exits non-zero when thresholds aren't met — fine here
}

// ─── Step 6 – summary ────────────────────────────────────────────────────────

const indexHtml = path.join(OUTPUT_DIR, 'index.html');
if (fs.existsSync(indexHtml)) {
  ok(`Report ready → ${path.relative(process.cwd(), indexHtml)}`);
  log(`Open it with:  open "${path.relative(process.cwd(), indexHtml)}"`);
} else {
  warn('index.html not found – check nyc output above for errors.');
}
