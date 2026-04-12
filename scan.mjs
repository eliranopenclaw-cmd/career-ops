#!/usr/bin/env node

/**
<<<<<<< HEAD
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
=======
 * career-ops: Portal Scanner v1.0
 * Scans 45+ company portals for new job openings matching target criteria
 *
 * Execution: node scan.mjs [--config portals.yml] [--parallel 5]
 *
 * Strategy:
 * 1. Read portals.yml configuration
 * 2. Read scan-history.tsv to dedup
 * 3. For each enabled company:
 *    - Fetch Greenhouse API (if available)
 *    - Attempt WebFetch of careers_url (for data-heavy sites)
 * 4. Filter by title keywords
 * 5. Verify liveness of any WebSearch results
 * 6. Add new roles to pipeline.md
 * 7. Record in scan-history.tsv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'portals.yml');
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'scan-history.tsv');
const PIPELINE_PATH = path.join(DATA_DIR, 'pipeline.md');

// Parse minimal YAML (limited to our needs)
function parseYaml(content) {
  const obj = {};
  let currentKey = null;
  let currentArray = null;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.match(/^(\s*)/)[1].length;

    if (line.includes(':') && !trimmed.startsWith('-')) {
      const [key, value] = line.split(':').map(s => s.trim());
      if (indent === 0) {
        obj[key] = value || {};
        currentKey = key;
        currentArray = null;
      } else if (currentKey && typeof obj[currentKey] === 'object' && !Array.isArray(obj[currentKey])) {
        if (!obj[currentKey][key]) obj[currentKey][key] = value;
      }
    } else if (trimmed.startsWith('-')) {
      if (!Array.isArray(obj[currentKey])) {
        obj[currentKey] = [];
        currentArray = obj[currentKey];
      }
      const item = trimmed.substring(1).trim();
      if (item.includes(':')) {
        const [k, v] = item.split(':').map(s => s.trim());
        const itemObj = {};
        itemObj[k] = v;
        currentArray.push(itemObj);
      } else {
        currentArray.push(item);
      }
    }
  }

  return obj;
}

// Read existing scan history
function readScanHistory() {
  if (!fs.existsSync(HISTORY_PATH)) {
    return new Map();
  }

  const content = fs.readFileSync(HISTORY_PATH, 'utf-8');
  const lines = content.split('\n').slice(1); // skip header
  const history = new Map();

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length >= 6) {
      const url = parts[0];
      history.set(url, { status: parts[5], title: parts[3], company: parts[4] });
    }
  }

  return history;
}

// Filter job titles by configured keywords
function filterByTitle(title, config) {
  if (!config.title_filter) return false;

  const { positive, negative, seniority_boost } = config.title_filter;

  // Must contain at least one positive keyword
  const hasPositive = positive.some(kw =>
    title.toLowerCase().includes(kw.toLowerCase())
  );

  if (!hasPositive) return false;

  // Must NOT contain any negative keywords
  const hasNegative = negative.some(kw =>
    title.toLowerCase().includes(kw.toLowerCase())
  );

  if (hasNegative) return false;

  return true;
}

// Fetch and parse Greenhouse API
async function fetchGreenhouseAPI(company) {
  if (!company.api) return [];

  try {
    const response = await fetch(company.api, {
      timeout: 5000,
      headers: { 'User-Agent': 'career-ops scanner/1.0' }
    });

    if (!response.ok) {
      console.log(`  ⚠ Greenhouse API failed for ${company.name} (${response.status})`);
      return [];
    }

    const data = await response.json();
    const jobs = data.jobs || [];

    return jobs.map(job => ({
      url: job.absolute_url,
      title: job.title,
      company: company.name,
      source: 'Greenhouse API'
    })).filter(j => j.url && j.title);
  } catch (err) {
    console.log(`  ⚠ Greenhouse API error for ${company.name}: ${err.message}`);
    return [];
  }
}

// Parse HTML to extract job listings (basic)
function extractJobsFromHTML(html, company) {
  const jobs = [];

  // Very simple: look for job title patterns in common ATS formats
  // This is a best-effort approach; real impl would use Playwright

  // Ashby pattern: <a href="..." class="...">Job Title</a>
  const ashbyPattern = /href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  let match;

  while ((match = ashbyPattern.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].trim();

    // Filter out navigation links, company name links, etc.
    if (title.length > 10 && title.length < 200 &&
        !title.toLowerCase().includes('company') &&
        !title.toLowerCase().includes('about') &&
        !title.toLowerCase().includes('careers')) {
      jobs.push({
        url: url.startsWith('http') ? url : `https://${company.careers_url.split('/')[2]}${url}`,
        title,
        company: company.name,
        source: company.careers_url
      });
    }
  }

  return jobs;
}

// Main scan execution
async function runScan() {
  console.log(`\n🔍 Career-Ops Portal Scanner — ${new Date().toISOString().split('T')[0]}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1. Read configuration
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ portals.yml not found. Run from career-ops directory.');
    process.exit(1);
  }

  const configContent = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const config = parseYaml(configContent);

  // 2. Read scan history for deduplication
  const scanHistory = readScanHistory();
  console.log(`📊 Loaded ${scanHistory.size} previously scanned URLs\n`);

  // 3. Scan enabled companies
  const trackedCompanies = config.tracked_companies || [];
  const enabledCompanies = trackedCompanies.filter(c => c.enabled !== false);

  let allJobs = [];
  let processedCompanies = 0;

  console.log(`⏳ Scanning ${enabledCompanies.length} configured companies...`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  for (const company of enabledCompanies) {
    process.stdout.write(`  • ${company.name.padEnd(25)}`);

    const jobs = [];

    // Try Greenhouse API first (fastest)
    if (company.api) {
      const apiJobs = await fetchGreenhouseAPI(company);
      jobs.push(...apiJobs);
      process.stdout.write(` [API: ${apiJobs.length}]`);
    }

    // Try WebFetch as fallback (may fail due to CORS/auth)
    if (!jobs.length && company.careers_url && company.scan_method !== 'websearch') {
      try {
        const response = await fetch(company.careers_url, {
          timeout: 3000,
          headers: { 'User-Agent': 'career-ops scanner/1.0' }
        });

        if (response.ok) {
          const html = await response.text();
          const fetchedJobs = extractJobsFromHTML(html, company);
          jobs.push(...fetchedJobs);
          process.stdout.write(` [Web: ${fetchedJobs.length}]`);
        }
      } catch (err) {
        // Silently fail - expected for protected sites
      }
    }

    allJobs.push(...jobs);
    console.log(` → ${jobs.length} jobs`);
    processedCompanies++;
  }

  console.log(`\n📦 Total jobs found: ${allJobs.length}`);

  // 4. Filter by title keywords
  const filtered = allJobs.filter(job =>
    filterByTitle(job.title, config)
  );

  console.log(`🎯 After title filter: ${filtered.length} relevant jobs`);

  // 5. Deduplicate
  const newJobs = filtered.filter(job => !scanHistory.has(job.url));
  console.log(`✨ New (not seen before): ${newJobs.length} jobs`);

  if (newJobs.length === 0) {
    console.log('\n✓ No new relevant roles found. Your pipeline is up to date.\n');
    return;
  }

  // 6. Update pipeline.md and scan-history.tsv
  const today = new Date().toISOString().split('T')[0];
  let historyContent = fs.readFileSync(HISTORY_PATH, 'utf-8');

  for (const job of newJobs) {
    const historyLine = `${job.url}\t${today}\t${job.source}\t${job.title}\t${job.company}\tadded\n`;
    historyContent += historyLine;
  }

  fs.writeFileSync(HISTORY_PATH, historyContent);

  // Append to pipeline.md (Pendientes section)
  let pipelineContent = fs.readFileSync(PIPELINE_PATH, 'utf-8');
  const pendientesIdx = pipelineContent.indexOf('## Pendientes');
  const insertIdx = pipelineContent.indexOf('\n\n', pendientesIdx) + 2;

  const newLines = newJobs.map((job, i) =>
    `- [ ] ${job.url} | ${job.company} | ${job.title}`
  ).join('\n');

  pipelineContent =
    pipelineContent.slice(0, insertIdx) +
    newLines + '\n\n' +
    pipelineContent.slice(insertIdx);

  fs.writeFileSync(PIPELINE_PATH, pipelineContent);

  // 7. Summary report
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✓ Scan Complete');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log(`📋 New roles added to pipeline:\n`);
  for (const job of newJobs.slice(0, 10)) {
    console.log(`  + ${job.company.padEnd(20)} | ${job.title}`);
  }

  if (newJobs.length > 10) {
    console.log(`  ... and ${newJobs.length - 10} more\n`);
  } else {
    console.log();
  }

  console.log(`→ Next: Run \`/career-ops pipeline\` to evaluate these roles.\n`);
}

// Run
runScan().catch(err => {
  console.error('❌ Scan failed:', err.message);
>>>>>>> d91d44b (local changes in career-ops)
  process.exit(1);
});
