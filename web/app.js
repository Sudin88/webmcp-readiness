/* All text from a scanned page reaches the DOM through textContent only.
   This file must never use innerHTML with server data. */
'use strict';

const form = document.getElementById('f');
const input = document.getElementById('url');
const button = document.getElementById('go');
const out = document.getElementById('out');

const SEVERITY_ORDER = { high: 0, medium: 1, info: 2 };
const stripSlash = (u) => String(u || '').replace(/\/+$/, '');

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function clear() {
  while (out.firstChild) out.removeChild(out.firstChild);
}

const OUTCOME_TEXT = {
  'tools-observable': 'Tools were found and called.',
  'no-tools': 'The page loaded but registered no WebMCP tools. If it should have some, they may register later than we waited.',
  'no-webmcp': 'This browser exposes no WebMCP API at all, so nothing could be inspected. That usually means the page does not use WebMCP.',
  unreachable: 'The page could not be loaded from here.'
};

function render(r, submittedUrl) {
  clear();

  if (r.blockedRequests && r.blockedRequests.count > 0) {
    const reasons = Object.entries(r.blockedRequests.reasons || {})
      .map(([reason, n]) => `${reason} (${n})`).join(', ');
    const w = el('div', 'notice');
    w.appendChild(el('strong', null, `${r.blockedRequests.count} request(s) from that page were blocked by the safety filter: `));
    w.appendChild(el('span', null, reasons));
    w.appendChild(el('span', null, ' Blocked requests are counted only, so this cannot be used to probe internal networks.'));
    out.appendChild(w);
  }

  if (r.outcome !== 'tools-observable') {
    // r.message is the server's own explanation; OUTCOME_TEXT is only a fallback,
    // and a missing key there previously rendered an empty box.
    const explain = r.message || OUTCOME_TEXT[r.outcome] || '';
    if (r.outcome === 'inconclusive' || r.outcome === 'partial') {
      const b2 = el('div', 'box');
      b2.appendChild(el('p', 'verdict warn', 'Readiness unknown'));
      b2.appendChild(el('h2', null, `${r.toolsFound || 0} tool(s) found, none responded`));
      b2.appendChild(el('p', 'muted', explain));
      out.appendChild(b2);
      return;
    }
    const box = el('div', 'box');
    box.appendChild(el('h2', null, 'Nothing to grade'));
    box.appendChild(el('p', null, explain || 'No result.'));
    out.appendChild(box);
    return;
  }

  const head = el('div', 'box');
  const blockers = r.summary.high || 0;
  const nits = r.summary.medium || 0;
  const unknown = r.inconclusive || 0;
  // A verdict that says "ready" while known defects exist is not a verdict.
  // A partial scan must never read as ready: we did not observe every tool.
  const verdict = blockers
    ? `${blockers} finding${blockers > 1 ? 's' : ''} will break AI agents`
    : unknown
      ? `Unknown \u2014 ${unknown} of ${r.toolsFound} tool(s) never responded`
      : nits
        ? `Usable by AI agents, with ${nits} thing${nits > 1 ? 's' : ''} worth fixing`
        : 'Ready for AI agents';
  head.appendChild(el('p', 'verdict ' + (blockers ? 'fail' : (unknown || nits) ? 'warn' : 'pass'), verdict));
  head.appendChild(el('h2', null, `${r.toolsFound} tool(s) found`));
  head.appendChild(el('p', 'muted', `${r.url} · HTTP ${r.status ?? '?'} · ${(r.durationMs / 1000).toFixed(1)}s`));
  // A redirect means we checked a different page than the one submitted. Say so,
  // otherwise the URL above looks like it was ignored.
  if (submittedUrl && stripSlash(r.url) !== stripSlash(submittedUrl)) {
    head.appendChild(el('p', 'muted', `Redirected from the submitted ${submittedUrl}`));
  }

  const counts = el('div', 'counts');
  for (const sev of ['high', 'medium', 'info']) {
    const n = r.summary[sev] ?? 0;
    const c = el('span', `count ${sev}`);
    c.dataset.n = String(n);
    c.appendChild(el('b', null, n));
    c.appendChild(document.createTextNode(' ' + sev));
    counts.appendChild(c);
  }
  head.appendChild(counts);
  out.appendChild(head);

  const findings = [...(r.findings || [])].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)
  );
  if (!findings.length) {
    out.appendChild(el('p', 'muted', `All ${r.toolsFound} tool(s) were called and answered both probes.`));
    return;
  }

  // Roll up by rule. The spec gap is one identical row per tool, which was filling
  // two thirds of the report with a fact that is not actionable yet.
  // Group by rule AND evidence. Rolling up by rule alone destroyed the product:
  // six HIGH findings each carry a different error string, and collapsing them
  // left the user with no actionable text at all. Identical evidence (the spec
  // gap, 16 identical rows) still collapses correctly.
  const byKey = new Map();
  for (const f of findings) {
    const k = `${f.rule}\u0000${f.detail || ''}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(f);
  }

  for (const [, group] of byKey) {
    const first = group[0];
    const card = el('div', `finding ${first.severity}`);
    const t = el('div', 't');
    // Severity as text, not just a border colour: a 3px hue is invisible to a
    // screen reader and to colour-blind users, who need to know which of 24
    // findings are the 6 blockers.
    t.appendChild(el('span', 'sev ' + first.severity, String(first.severity).toUpperCase()));
    if (group.length === 1) {
      if (first.tool) t.appendChild(el('code', 'tool', first.tool));
      t.appendChild(document.createTextNode(' '));
      t.appendChild(el('span', null, first.title || first.rule));
    } else {
      t.appendChild(el('span', null, `${first.title || first.rule} ×${group.length}`));
    }
    card.appendChild(t);

    // Evidence renders whenever there IS evidence, even in a group. Rendering it
    // only for singletons lost the error string whenever N tools shared one - which
    // is the systemic case, e.g. every tool hitting the same downstream failure.
    if (group.length > 1) {
      const names = el('div', 'd');
      names.appendChild(el('span', null, group.map((f) => f.tool).filter(Boolean).join(', ')));
      card.appendChild(names);
    }
    if (first.detail) card.appendChild(el('div', 'd', first.detail));
    if (first.explanation) card.appendChild(el('div', 'd muted', first.explanation));
    out.appendChild(card);
  }

  if (r.tools && r.tools.length) {
    const det = el('details');
    det.appendChild(el('summary', null, `${r.tools.length} tool(s) discovered`));
    for (const tool of r.tools) {
      const row = el('div', 'tool');
      row.appendChild(el('code', null, tool.name));
      // description is attacker-controlled page text: textContent, never markup
      row.appendChild(el('span', 'muted', tool.description || ''));
      det.appendChild(row);
    }
    out.appendChild(det);
  }
}

function fail(message, extra) {
  clear();
  const box = el('div', 'box error');
  box.appendChild(el('h2', null, 'Could not check that'));
  box.appendChild(el('p', null, message));
  if (extra) box.appendChild(el('p', 'muted', extra));
  out.appendChild(box);
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const url = input.value.trim();
  if (!url) return;

  button.disabled = true;
  button.textContent = 'Checking…';
  clear();
  const spinner = el('div', 'box');
  spinner.appendChild(el('h2', null, 'Opening the page in a browser'));
  spinner.appendChild(el('p', 'muted',
    'This takes 10–30 seconds. Every discovered tool is called, twice, plus once with a required field omitted.'));
  out.appendChild(spinner);

  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json().catch(() => ({ error: 'bad_response' }));

    if (res.status === 429 || res.status === 503) {
      fail('Too many scans right now.',
        `${data.error || 'rate limited'} — retry in ${res.headers.get('retry-after') || 60}s.`);
      return;
    }
    if (res.status === 400) {
      fail('That URL was refused.', data.error || 'blocked by the safety filter');
      return;
    }
    if (!res.ok) {
      fail(`The scan failed (HTTP ${res.status}).`, data.error || '');
      return;
    }
    render(data, url);
  } catch (e) {
    fail('Network error while checking.', String(e.message || '').slice(0, 120));
  } finally {
    button.disabled = false;
    button.textContent = 'Check';
  }
});