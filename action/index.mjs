/**
 * WebMCP Readiness Action entry point.
 *
 * Reads a config listing URLs, probes each one's WebMCP tools, grades them against
 * the spec's own guidance, and fails the build on high-severity findings.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, probePage } from '../lib/probe.mjs';
import { grade, RULES, describeFinding } from '../lib/checks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GITHUB_ROOT = process.env.GITHUB_WORKSPACE || process.cwd();

const input = (k, d) => (process.env[`INPUT_${k.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] ?? d);

const escape = (s) =>
  String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');

const emit = (level, msg) => {
  if (process.env.GITHUB_ACTIONS) process.stdout.write(`::${level}::${escape(msg)}\n`);
  else process.stdout.write(`  ${msg}\n`);
};
const error = (msg) => emit('error', msg);
const warning = (msg) => emit('warning', msg);
const notice = (msg) => emit('notice', msg);
const group = (name) => process.stdout.write(`\n::group::${name}\n`);
const endGroup = () => process.stdout.write('::endgroup::\n');

// ---------------------------------------------------------------- config

const configPath = resolve(GITHUB_ROOT, input('config', 'webmcp.config.json'));
if (!existsSync(configPath)) {
  error(`Config not found: ${input('config', 'webmcp.config.json')}`);
  process.exit(1);
}
let cfg;
try {
  cfg = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (e) {
  error(`Config is not valid JSON: ${e.message}`);
  process.exit(1);
}

const urls = Array.isArray(cfg.urls) ? cfg.urls.filter((u) => typeof u === 'string' && u.trim()) : [];
if (!urls.length) {
  error('Config has no "urls" array with at least one entry.');
  process.exit(1);
}

const failOn = String(input('fail-on', 'high')).toLowerCase();
const failOnUnreachable = String(input('fail-on-unreachable', 'true')).toLowerCase() !== 'false';
const wantSummary = String(input('github-summary', 'true')).toLowerCase() !== 'false';
const reportPath = join(GITHUB_ROOT, input('report-path', 'webmcp-report.json'));

// ---------------------------------------------------------------- run

group(`WebMCP readiness: ${urls.length} URL${urls.length === 1 ? '' : 's'}`);
const browser = await chromium.launch();
const results = [];

try {
  for (const url of urls) {
    process.stdout.write(`  checking ${url} ...\n`);
    const page = await probePage(browser, url);

    if (page.outcome === 'unreachable') {
      // Severity follows the fail-on-unreachable switch. Marking it high here
      // would make fail-on:high override the switch and re-fail the build, so
      // the two inputs silently fought each other.
      page.findings = [{
        rule: 'page-unreachable',
        severity: failOnUnreachable ? 'high' : 'info',
        detail: page.error || 'could not load'
      }];
    } else if (page.outcome === 'no-tools') {
      page.findings = [{ rule: 'no-tools-registered', severity: 'medium', detail: 'page loaded but registered no WebMCP tools' }];
    } else {
      const siteLevel = new Set();
      for (const t of page.tools) {
        for (const f of grade(t, page.tools.length)) {
          if (f.site) {
            if (siteLevel.has(f.rule)) continue;
            siteLevel.add(f.rule);
            page.findings.push({ ...f });
          } else {
            page.findings.push({ tool: t.name, ...f });
          }
        }
      }
    }

    const nHigh = page.findings.filter((f) => f.severity === 'high').length;
    process.stdout.write(
      `    ${page.outcome}${page.tools.length ? `, ${page.tools.length} tool(s)` : ''}` +
        `${page.findings.length ? `, ${nHigh} high / ${page.findings.length - nHigh} lower` : ''}\n`
    );
    results.push(page);
  }
} finally {
  await browser.close();
}
endGroup();

// ---------------------------------------------------------------- report

const allFindings = results.flatMap((r) => r.findings.map((f) => ({ ...f, url: r.url })));
const high = allFindings.filter((f) => f.severity === 'high');
const medium = allFindings.filter((f) => f.severity === 'medium');
const info = allFindings.filter((f) => f.severity === 'info');
const toolsFound = results.reduce((a, r) => a + r.tools.length, 0);

const report = {
  checkedAt: new Date().toISOString(),
  urls: urls.length,
  toolsFound,
  findings: { high: high.length, medium: medium.length, info: info.length, total: allFindings.length },
  results
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));

if (process.env.GITHUB_OUTPUT) {
  const fs = await import('node:fs');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tools_found=${toolsFound}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `findings=${allFindings.length}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `high=${high.length}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `report=${reportPath}\n`);
}

// GitHub annotations, so findings show inline in the PR diff.
for (const f of allFindings) {
  const meta = RULES[f.rule];
  const msg = `${meta?.title || f.rule}${f.tool ? ` (${f.tool})` : ''}${f.detail ? ` - ${f.detail}` : ''}`;
  if (f.rule === 'output-schema-declared') continue; // universal today; see report
  f.severity === 'high' ? error(msg) : warning(msg);
}

// ---------------------------------------------------------------- summary

if (wantSummary && process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => {
    const h = r.findings.filter((f) => f.severity === 'high').length;
    return `| ${r.url} | ${r.outcome} | ${r.tools.length} | ${h} | ${r.findings.filter((f) => f.severity === 'medium').length} | ${r.findings.filter((f) => f.severity === 'info').length} |`;
  });
  const md = [
    '## WebMCP readiness',
    '',
    `**${toolsFound}** tool(s) found across **${urls.length}** URL(s) - **${high.length}** high, **${medium.length}** lower severity finding(s).`,
    '',
    '| URL | Outcome | Tools | High | Medium | Info |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `<sub>Report: \`${input('report-path', 'webmcp-report.json')}\` - rules are derived from the WebMCP spec's own guidance.</sub>`
  ].join('\n');
  const fs = await import('node:fs');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}

// ---------------------------------------------------------------- verdict

notice(
  `WebMCP readiness: ${toolsFound} tool(s), ${high.length} high, ${medium.length} medium, ${info.length} info (info = spec gap, not fixable yet).`
);

const shouldFail =
  (failOn === 'high' && high.length > 0) ||
  (failOn === 'medium' && (high.length > 0 || medium.length > 0)) ||
  (failOnUnreachable && results.some((r) => r.outcome === 'unreachable'));

if (shouldFail) {
  group('Why this failed');
  for (const f of high) process.stdout.write(describeFinding(f.tool, f) + '\n');
  endGroup();
  error(
    `WebMCP readiness failed (${high.length} high severity, fail-on=${failOn}). ` +
      `Set fail-on: none to report without failing.`
  );
  process.exit(1);
}

process.stdout.write('WebMCP readiness passed.\n');
