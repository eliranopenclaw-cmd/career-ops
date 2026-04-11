#!/usr/bin/env node

/**
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
  process.exit(1);
});
