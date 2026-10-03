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
    const box = el('div', 'box');
    box.appendChild(el('h2', null, 'Nothing to grade'));
    box.appendChild(el('p', null, OUTCOME_TEXT[r.outcome] || r.message || 'No result.'));
    if (r.message && OUTCOME_TEXT[r.outcome]) box.appendChild(el('p', 'muted', r.message));
    out.appendChild(box);
    return;
  }

  const head = el('div', 'box');
  head.appendChild(el('h2', null, `${r.toolsFound} tool(s) found`));
  head.appendChild(el('p', 'muted', `${r.url} · HTTP ${r.status ?? '?'} · ${(r.durationMs / 1000).toFixed(1)}s`));
  // A redirect means we checked a different page than the one submitted. Say so,
  // otherwise the URL above looks like it was ignored.
  if (submittedUrl && stripSlash(r.url) !== stripSlash(submittedUrl)) {
    head.appendChild(el('p', 'muted', `Redirected from the submitted ${submittedUrl}`));
  }

  const counts = el('div', 'counts');
  for (const sev of ['high', 'medium', 'info']) {
    const c = el('span', `count ${sev}`);
    c.appendChild(el('b', null, r.summary[sev] ?? 0));
    c.appendChild(document.createTextNode(' ' + sev));
    counts.appendChild(c);
  }
  head.appendChild(counts);
  out.appendChild(head);

  const findings = [...(r.findings || [])].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)
  );
  if (!findings.length) {
    out.appendChild(el('p', 'muted', 'No findings.'));
    return;
  }

  // The same explanation repeats verbatim across every instance of a rule. Show it
  // once, under the first finding of that rule.
  const explained = new Set();
  for (const f of findings) {
    const card = el('div', `finding ${f.severity}`);
    const t = el('div', 't');
    if (f.tool) t.appendChild(el('code', 'tool', f.tool));
    t.appendChild(document.createTextNode(' '));
    t.appendChild(el('span', null, f.title || f.rule));
    card.appendChild(t);
    if (f.detail) card.appendChild(el('div', 'd', f.detail));
    // The explanation is identical for every instance of a rule, so show it once.
    if (!explained.has(f.rule)) {
      explained.add(f.rule);
      if (f.explanation) card.appendChild(el('div', 'd muted', f.explanation));
    }
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