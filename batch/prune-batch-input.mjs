#!/usr/bin/env node

/**
 * prune-batch-input.mjs — re-applies the CURRENTLY ACTIVE portals-cv{1,2,3}.yml
 * gates to the pending queue in batch/batch-input.tsv.
 *
 * Scan gates apply at SCAN time. Rows already queued in batch-input.tsv were
 * added under whatever gates were active when they were scanned/backlogged,
 * and are never re-filtered when the gates change later (issue #16 -- PR #14
 * narrowed portals-cv1.yml to Austria-only; the pre-existing queue still
 * reflects the pre-#14 world, so running the batch as-is spends eval budget
 * on roles that are no longer in scope for any enabled track).
 *
 * Reuses scan.mjs's own exported filter builders (buildTitleFilter,
 * buildLocationFilter) rather than hand-rolling a second matching
 * implementation -- a divergent copy is exactly the drift this codebase
 * warns against elsewhere (see scan.mjs's own header comments).
 *
 * Multi-track correctness: batch-input.tsv's `source` column does not
 * reliably encode which track a row was queued for (578 of 629 rows in the
 * live queue are `source=backlog`, with no track marker at all -- only 50
 * older rows say `sweep-cv1`/`sweep-cv2`). So a row is DROPPED only if it
 * fails EVERY enabled track's title+location gates -- the conservative
 * option the issue names: a German-located AI role is out of scope for CV-1
 * but may be exactly right for CV-2, and this must not prune it just because
 * CV-1's gate alone would reject it.
 *
 * Location (and title) come from data/scan-history.tsv, joined on url. A row
 * with NO scan-history entry, or no location on file, is always KEPT --
 * same "don't penalize missing data" posture location_filter itself uses;
 * pruning what we can't judge would silently lose real work.
 *
 * NON-DESTRUCTIVE: batch-input.tsv itself is never modified. Real (non
 * --dry-run) runs write two NEW files instead:
 *   - batch/batch-input.kept.tsv    -- survives at least one enabled track
 *   - batch/batch-input.pruned.tsv  -- fails every enabled track, plus WHY
 * Nothing is ever deleted; activating the pruned queue is a deliberate,
 * separate step left to the operator (see the printed instructions).
 *
 * Usage:
 *   node batch/prune-batch-input.mjs --dry-run   # counts only, no writes
 *   node batch/prune-batch-input.mjs             # writes the two files above
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { buildLocationFilter, buildTitleFilter } from '../scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const INPUT_PATH = resolve(HERE, 'batch-input.tsv');
const SCAN_HISTORY_PATH = resolve(ROOT, 'data/scan-history.tsv');
const KEPT_PATH = resolve(HERE, 'batch-input.kept.tsv');
const PRUNED_PATH = resolve(HERE, 'batch-input.pruned.tsv');
const STATE_PATH = resolve(HERE, 'batch-state.tsv');

const TRACK_FILES = ['portals-cv1.yml', 'portals-cv2.yml', 'portals-cv3.yml'];

/** @returns {Array<{track: string, titleFilter: Function, locationFilter: Function}>} */
function loadTrackGates() {
  const gates = [];
  for (const name of TRACK_FILES) {
    const p = resolve(ROOT, name);
    if (!existsSync(p)) continue;
    const cfg = yaml.load(readFileSync(p, 'utf-8'));
    gates.push({
      track: name.replace(/\.yml$/, ''),
      titleFilter: buildTitleFilter(cfg.title_filter),
      locationFilter: buildLocationFilter(cfg.location_filter),
    });
  }
  return gates;
}

/**
 * Ids already tracked in batch-state.tsv are no longer "pending" -- they've
 * been started (completed/failed/paused/processing/...), so pruning must
 * leave them alone regardless of what the current gates would say about
 * them now. Only rows batch-runner.sh has never touched are candidates.
 * @returns {Set<string>}
 */
function loadProcessedIds() {
  const ids = new Set();
  if (!existsSync(STATE_PATH)) return ids;
  const lines = readFileSync(STATE_PATH, 'utf-8').split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(1)) {
    const id = line.split('\t')[0];
    if (id) ids.add(id);
  }
  return ids;
}

/** @returns {Map<string, {title: string, location: string}>} url -> {title, location} */
function loadScanHistory() {
  const map = new Map();
  if (!existsSync(SCAN_HISTORY_PATH)) return map;
  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const url = cols[0];
    if (!url) continue;
    // Positional, not header-name-mapped: scan-history.tsv's header row only
    // labels the first 7 of its 9 columns (col 8 = simhash, col 9 = posting
    // date, per DATA_CONTRACT.md) -- title is col 4 (index 3), location col 7
    // (index 6).
    map.set(url, { title: cols[3] || '', location: cols[6] || '' });
  }
  return map;
}

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  if (!existsSync(INPUT_PATH)) {
    console.error(`prune-batch-input: ${INPUT_PATH} not found -- nothing to prune.`);
    process.exit(1);
  }

  const gates = loadTrackGates();
  if (gates.length === 0) {
    console.error('prune-batch-input: no portals-cvN.yml files found -- refusing to prune against zero gates.');
    process.exit(1);
  }
  const history = loadScanHistory();
  const processedIds = loadProcessedIds();

  const lines = readFileSync(INPUT_PATH, 'utf-8').split(/\r?\n/).filter(Boolean);
  const header = lines[0];
  const dataLines = lines.slice(1);

  const kept = [];
  const dropped = []; // [...originalCols, reason]
  let keptAlreadyProcessed = 0;
  let keptNoHistory = 0;
  let keptNoLocation = 0;
  let keptPassesGate = 0;

  for (const line of dataLines) {
    const cols = line.split('\t');
    const [id, url] = cols;
    if (!id || !url || !/^\d+$/.test(id)) continue; // guard against stray/malformed rows

    // Not pending -- already started per batch-state.tsv. Leave it exactly
    // where it is; pruning only ever applies to never-touched rows.
    if (processedIds.has(id)) {
      kept.push(line);
      keptAlreadyProcessed++;
      continue;
    }

    const meta = history.get(url);
    if (!meta) {
      kept.push(line);
      keptNoHistory++;
      continue;
    }
    if (!meta.location || meta.location.trim() === '') {
      kept.push(line);
      keptNoLocation++;
      continue;
    }

    const passesAnyTrack = gates.some(
      (g) => g.titleFilter(meta.title) && g.locationFilter(meta.location, url),
    );
    if (passesAnyTrack) {
      kept.push(line);
      keptPassesGate++;
    } else {
      const tracks = gates.map((g) => g.track).join(', ');
      dropped.push([
        ...cols,
        `fails every enabled track's gates (${tracks}) -- title="${meta.title}" location="${meta.location}"`,
      ]);
    }
  }

  const keptTotal = kept.length;
  const pendingCount = dataLines.length - keptAlreadyProcessed;
  console.log(`Total rows in batch-input.tsv:        ${dataLines.length}`);
  console.log(`Already processed (batch-state.tsv):  ${keptAlreadyProcessed} (left untouched)`);
  console.log(`Pending rows considered for pruning:  ${pendingCount}`);
  console.log(`Kept -- no scan-history entry:        ${keptNoHistory}`);
  console.log(`Kept -- no location on file:          ${keptNoLocation}`);
  console.log(`Kept -- passes >=1 enabled track:     ${keptPassesGate}`);
  console.log(`Kept total:                           ${keptTotal}`);
  console.log(`Dropped -- fails every enabled track: ${dropped.length}`);

  if (dropped.length > 0) {
    console.log('\nSample of dropped rows (up to 10):');
    for (const row of dropped.slice(0, 10)) {
      console.log(`  #${row[0]} ${row[1]}`);
      console.log(`      ${row[row.length - 1]}`);
    }
  }

  if (dryRun) {
    console.log('\n--dry-run: no files written.');
    return;
  }

  writeFileSync(KEPT_PATH, `${header}\n${kept.join('\n')}\n`);
  writeFileSync(
    PRUNED_PATH,
    `${header}\treason\n${dropped.map((r) => r.join('\t')).join('\n')}\n`,
  );
  console.log(`\nWrote ${kept.length} kept rows to ${KEPT_PATH}`);
  console.log(`Wrote ${dropped.length} dropped rows (with reason) to ${PRUNED_PATH}`);
  console.log('batch-input.tsv was NOT modified. To activate the pruned queue:');
  console.log('  mv batch/batch-input.kept.tsv batch/batch-input.tsv');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
