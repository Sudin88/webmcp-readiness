/**
 * Baseline diffing for the WebMCP Readiness action.
 *
 * Purpose: let a team adopt the action on a codebase that already has broken
 * contracts, without every existing finding failing CI on day one. Only NEW
 * findings fail. Pre-existing ones are reported as "known" so the number of
 * things you have not fixed yet stays visible.
 *
 * Design rule: a baseline must never become a place to hide regressions. So
 * everything absorbed by a baseline update is printed explicitly, and removing
 * a tool from a site is treated as a REGRESSION rather than a fix.
 *
 * Pure functions, no I/O, so this is fully unit-testable without a browser.
 */

/** Stable identity for a finding, so a baseline survives reordering and re-runs. */
export function findingKey(finding) {
  return [finding.url || '', finding.tool || '', finding.rule].join('|');
}

/** Stable identity for an observed tool. */
export function toolKey(url, toolName) {
  return [url, toolName || ''].join('|');
}

export const BASELINE_VERSION = 1;

/** Convert a scan/action result into the flat, comparable shape the baseline stores. */
export function toBaseline(report, { note = '' } = {}) {
  const findings = [];
  const tools = [];
  for (const r of report.results) {
    const url = r.url;
    for (const t of r.tools || []) tools.push(toolKey(url, t.name));
    for (const f of r.findings || []) {
      if (f.rule === 'not-probed') continue; // transient by nature
      findings.push({
        url,
        tool: f.tool || null,
        rule: f.rule,
        severity: f.severity,
        detail: f.detail || null
      });
    }
  }
  return {
    version: BASELINE_VERSION,
    capturedAt: report.checkedAt || new Date().toISOString(),
    note,
    tools: [...new Set(tools)].sort(),
    findings: dedupe(findings)
  };
}

function dedupe(findings) {
  const seen = new Map();
  for (const f of findings) {
    const k = findingKey(f);
    if (!seen.has(k)) seen.set(k, f);
  }
  return [...seen.values()].sort((a, b) => findingKey(a).localeCompare(findingKey(b)));
}

/**
 * Compare a live result against a baseline.
 *
 * Returns four buckets:
 *   new      - findings that were not in the baseline  (the only ones that fail)
 *   known    - findings already in the baseline         (reported, never fail)
 *   fixed    - findings in the baseline that no longer occur
 *   regressions - tools that WERE registered and now are not
 *
 * A tool disappearing is a regression, not a fix: an agent that relied on
 * `order-prints` can no longer call it. Treating that as resolved would be the
 * single most damaging mistake this tool could make.
 */
/** Outcomes for which we actually observed enough to judge the page. */
export const READABLE_OUTCOMES = new Set(['tools-observable', 'partial', 'no-tools']);

export function diffReport(report, baseline) {
  const base = baseline && baseline.version === BASELINE_VERSION ? baseline : { findings: [], tools: [] };
  const baseFindings = new Set((base.findings || []).map(findingKey));
  const baseTools = new Set(base.tools || []);

  const added = [];
  const known = [];
  for (const r of report.results) {
    for (const f of r.findings || []) {
      if (f.rule === 'not-probed') continue;
      const item = {
        url: r.url,
        tool: f.tool || null,
        rule: f.rule,
        severity: f.severity,
        detail: f.detail || null
      };
      (baseFindings.has(findingKey(item)) ? known : added).push(item);
    }
  }

  const liveTools = new Set();
  for (const r of report.results) for (const t of r.tools || []) liveTools.add(toolKey(r.url, t.name));

  const regressions = [];
  for (const k of baseTools) {
    if (!liveTools.has(k)) {
      const [url, name] = k.split('|');
      // Only a regression if we could actually read the page this run.
      const readThisRun = report.results.some(
        (r) => r.url === url && READABLE_OUTCOMES.has(r.outcome)
      );
      if (readThisRun) regressions.push({ url, tool: name });
    }
  }

  // Must include the url, exactly as the newFindings/knownFindings keys do.
  // Building these from the raw per-tool findings (which carry no url) makes every
  // pre-existing finding look "fixed", which would tempt people to delete real
  // entries from their baseline.
  const seenNow = new Set(
    report.results.flatMap((r) =>
      (r.findings || [])
        .filter((f) => f.rule !== 'not-probed')
        .map((f) => findingKey({ url: r.url, tool: f.tool, rule: f.rule }))
    )
  );
  // Only consider a finding fixed if we could actually read that page this run.
  // An unreachable page yields no findings, so without this guard every baselined
  // finding looks fixed and --update-baseline silently deletes them all.
  // Positive allowlist, not a negative test: an outcome added later must fail
  // loudly rather than silently counting as readable.
  const readable = new Set(report.results.filter((r) => READABLE_OUTCOMES.has(r.outcome)).map((r) => r.url));
  const fixed = (base.findings || []).filter(
    (f) => readable.has(f.url) && !seenNow.has(findingKey(f))
  );

  return {
    newFindings: dedupe(added),
    knownFindings: dedupe(known),
    fixedFindings: dedupe(fixed.map((f) => ({ url: f.url, tool: f.tool, rule: f.rule, severity: f.severity }))),
    regressions,
    toolsSeen: liveTools.size
  };
}

/** How many new findings would be absorbed if the baseline were rewritten. */
export function summarise(d) {
  return {
    added: d.newFindings.length,
    known: d.knownFindings.length,
    fixed: d.fixedFindings.length,
    regressions: d.regressions.length,
    newHigh: d.newFindings.filter((f) => f.severity === 'high').length,
    newMedium: d.newFindings.filter((f) => f.severity === 'medium').length
  };
}

/** A guard, not a rule: warn when a baseline update would absorb an unusual number of new findings. */
export function baselineUpdateWarning(d) {
  const s = summarise(d);
  const notes = [];
  if (s.added > 25) {
    notes.push(
      `${s.added} new findings would be absorbed. A baseline that grows this fast usually means the check is being switched off rather than the code being fixed - review before committing.`
    );
  }
  if (s.newHigh > 10) {
    notes.push(
      `${s.newHigh} new HIGH severity findings would be absorbed. If these are real defects, fix them instead of baselining them.`
    );
  }
  if (s.regressions > 0) {
    notes.push(
      `${s.regressions} tool(s) present in the baseline are no longer registered. Regressions are never absorbed silently - check whether the site removed a tool.`
    );
  }
  return notes;
}

/** Render the exact list of findings a baseline update would add. */
export function renderNewForBaseline(d) {
  if (!d.newFindings.length) return '  (nothing new to absorb)\n';
  return d.newFindings
    .map((f) => `  + ${f.severity.padEnd(6)} ${f.rule.padEnd(28)} ${f.url}${f.tool ? ` :: ${f.tool}` : ''}\n`)
    .join('');
}
