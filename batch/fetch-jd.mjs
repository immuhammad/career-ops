#!/usr/bin/env node
/**
 * fetch-jd.mjs — render a job posting with a real browser and write its text out.
 *
 * WHY THIS EXISTS
 * batch-runner.sh hands each eval worker an EMPTY temp file and tells it
 * "JD file: <path>". Nothing ever populated it, so the worker fell back to a
 * plain HTTP fetch — which returns no usable content for client-side-rendered
 * ATS pages (Workday, Ashby, NVIDIA, SmartRecruiters SPAs). Those postings then
 * failed with "JD unavailable", and because the runner judges success on shell
 * exit code alone they were recorded `completed` with no report and silently
 * dropped out of the queue. 9 rows were parked this way on 2026-07-30.
 *
 * Playwright + Chromium are already installed and already driven by
 * archive-posting.mjs; the capability existed, the wire did not. Page-load
 * settings below match that proven path (domcontentloaded + a hydration wait).
 *
 * Usage:  node batch/fetch-jd.mjs <url> <output-file> [--min-chars N] [--timeout MS]
 * Exit:   0 = wrote usable text
 *         1 = no usable text (caller should treat the posting as unevaluable,
 *             NEVER score it from the title or URL slug — see house rule 17)
 *         2 = bad invocation
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const args = process.argv.slice(2);
if (args.length < 2 || args.includes('-h') || args.includes('--help')) {
  console.error('Usage: node batch/fetch-jd.mjs <url> <output-file> [--min-chars N] [--timeout MS]');
  process.exit(2);
}
const [url, outPath] = args;
const numArg = (flag, dflt) => {
  const i = args.indexOf(flag);
  if (i < 0 || !args[i + 1]) return dflt;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const MIN_CHARS = numArg('--min-chars', 400);
const TIMEOUT = numArg('--timeout', 30000);
// Workday in particular needs well over the 2.5s that sufficed for the PDF
// archiver; give hydration its own, longer budget.
const HYDRATE_TIMEOUT = numArg('--hydrate-timeout', 20000);

// Most-specific first; each ATS puts the description in a known container, and
// scoping to it keeps nav/cookie-banner/footer noise out of the JD text.
const SELECTORS = [
  '[data-automation-id="jobPostingDescription"]', // Workday
  '[data-automation-id="jobPostingPage"]',        // Workday (outer)
  'div[class*="_descriptionText"]',               // Ashby
  'div[class*="ashby-job-posting"]',              // Ashby
  '#content .posting',                            // Lever
  'div.posting-page',                             // Lever
  '#job-details',                                 // SmartRecruiters
  'section[class*="job-description"]',
  'div[class*="job-description"]',
  'article',
  'main',
  'body',                                         // last resort
];

const clean = (s) =>
  s.replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    // Some ATS hosts serve a stub to unknown agents; a normal UA avoids that
    // without pretending to be a different browser engine than we are.
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  const status = response?.status() ?? 0;

  // Wait for CONTENT, not for a clock. Measured 2026-07-30: a CrowdStrike
  // Workday page has an empty body AND an empty <title> at 2.5s, then reaches
  // 8266 chars once its SPA hydrates — a fixed sleep silently produced an empty
  // JD. Polling body length is ATS-agnostic, so this needs no per-vendor tuning
  // and returns immediately on pages that render server-side.
  await page
    .waitForFunction(
      (min) => ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().length >= min,
      MIN_CHARS,
      { timeout: HYDRATE_TIMEOUT },
    )
    .catch(() => {}); // fall through and let the length check below decide
  // Brief settle so late-injected description blocks land before extraction.
  await page.waitForTimeout(1200);
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});

  let text = '';
  let used = 'none';
  for (const sel of SELECTORS) {
    const t = await page.$eval(sel, (el) => el.innerText || '').catch(() => '');
    const c = clean(t);
    if (c.length >= MIN_CHARS) { text = c; used = sel; break; }
    if (c.length > text.length) { text = c; used = sel; } // keep best-effort fallback
  }

  const title = await page.title().catch(() => '');
  await browser.close();
  browser = null;

  if (text.length < MIN_CHARS) {
    console.error(`fetch-jd: no usable JD text (HTTP ${status}, best ${text.length} chars via ${used}) ${url}`);
    process.exit(1);
  }

  // Header gives the worker provenance; it must never invent a JD, so an empty
  // body here has to stay empty rather than be padded with guesses.
  const header = [`SOURCE URL: ${url}`, `PAGE TITLE: ${title}`, `FETCHED: ${new Date().toISOString()}`, `EXTRACTED VIA: ${used}`, `HTTP: ${status}`, '', '---', ''].join('\n');
  writeFileSync(outPath, header + text + '\n');
  console.log(`fetch-jd: wrote ${text.length} chars via ${used} (HTTP ${status})`);
  process.exit(0);
} catch (err) {
  if (browser) await browser.close().catch(() => {});
  console.error(`fetch-jd: ${err.message.split('\n')[0]} ${url}`);
  process.exit(1);
}
