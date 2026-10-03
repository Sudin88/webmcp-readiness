# WebMCP Readiness

Verify the WebMCP tools your site exposes to AI agents — in CI, before they ship.

The WebMCP spec landed **30 September 2026**. A baseline scan of the public registry
([full report](REPORT.md)) found that **0 of 114 observable tools declare what they
return**, 8 tools throw on input that satisfies their own schema, and one registry
entry advertises 29 tools that do not exist on the page.

None of that is visible today, because nothing checks it. This action does.

---

## What it checks

Every rule is taken from the spec's own guidance, not invented:

| Rule | Severity | Source |
|---|---|---|
| Tool has no description | high | "Frame tool descriptions around what the tool accomplishes" |
| Description too short to be useful | medium | same |
| Input schema fields undocumented | medium | "Document schemas with descriptions… to help the agent supply appropriate values" |
| Tool accepted a call missing a required field | high | "Validate strictly in code, loosely in schema" |
| Tool threw on schema-valid input | high | schema and implementation must agree |
| Response SHAPE differs between identical calls | medium | the contract itself changed between calls |
| Response VALUES differ, shape stable | **info** | volatile data (timestamp, request id) — not a defect |
| Page registers too many tools | medium (>15) | "Exposing too many tools can severely degrade agent performance" |
| Tool declares no output contract | **info** | `outputSchema` does not exist in the spec yet (issue #9) — **never fails CI** |
| Page unreachable | high (configurable) | a broken site must not pass silently |

The last-but-one rule is `info` on purpose: it is true of **100% of tools** in the
public registry today and is not fixable by an implementer. Failing builds on an
unfixable spec gap would make this action useless, so it is reported and never fatal.

---

## Usage

Create `webmcp.config.json` in your repo:

```json
{
  "urls": [
    "https://your-app.example",
    "https://checkout.your-app.example/pay"
  ]
}
```

Add the workflow:

```yaml
name: webmcp
on: [push, pull_request]

jobs:
  readiness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: your-org/webmcp-readiness@v1
```

That's it. Findings appear as inline annotations on the PR diff.

### Inputs

| Input | Default | Meaning |
|---|---|---|
| `config` | `webmcp.config.json` | Path to the URL list |
| `fail-on` | `high` | `high`, `medium`, or `none` |
| `fail-on-unreachable` | `true` | Fail when a URL cannot be checked |
| `report-path` | `webmcp-report.json` | Where to write the JSON report |
| `github-summary` | `true` | Write a Markdown table to the job summary |

### Outputs

`tools-found`, `findings`, `high`, `report`.

---

## Adopting it on a site that already has broken tools

A first run on a real site fails. That is the point — but it also means the
action is unusable on day one unless you have a way to accept the current state.

Commit a baseline:

```yaml
- uses: your-org/webmcp-readiness@v1
  with:
    config: webmcp.config.json
    update-baseline: true   # one-off: accept what exists now
```

That writes `webmcp-baseline.json` and prints **every finding it absorbed**, one per
line, so the diff is reviewable:

```
absorbing 24 new finding(s) (6 high)

newly absorbed:
  + high   tolerates-valid-args        https://www.proxy-compare.com :: read_site_guide
  + medium tool-budget                https://www.proxy-compare.com
  ...
```

From then on, **only new findings fail the build.** Pre-existing ones keep failing
nothing but stay visible:

```
Baseline webmcp-baseline.json: 0 new, 24 known, 0 fixed, 0 regression(s).
6 high severity finding(s) are already in the baseline and are not failing this
build. They are still real defects.
```

### Two things the baseline deliberately will not do

**It will not absorb a removed tool.** If a tool that was in your baseline is no
longer registered, the build fails:

```
https://your-app.example no longer registers `checkout_and_pay`, which was in the
baseline. An agent relying on it can no longer call it.
```

A disappearing tool is a **regression, not a fix**. An agent that called
`checkout_and_pay` yesterday gets a failure today, and the people who depend on
that are your users, not your CI. This is the single most damaging mistake a tool
like this could make, so it fails loudly and cannot be baselined away silently.

**It will not absorb a suspiciously large jump.** Updating a baseline that would
add 25+ findings, or 10+ new high-severity ones, prints a warning — because a
baseline that grows that fast usually means the check is being switched off
rather than the code being fixed.

### Keeping it honest

When a finding is fixed, the build tells you to remove it from the baseline:

```
fixed since baseline: schema-fields-documented (get_sale_rules) on https://... -
remove it from the baseline to keep it honest.
```

That keeps the baseline shrinking instead of turning into a graveyard of things
nobody ever came back to.

---

## The probe, and why it is trustworthy

A verification tool that reports false positives is worse than no tool. Two of the
three bugs we hit while building the baseline scanner were false-positive
generators, so the checks are built defensively and documented in `lib/checks.mjs`:

1. **Transport success is not input acceptance.** A tool that correctly rejects a
   call usually returns `{"isError": true, …}` rather than throwing. Our first
   version only checked for exceptions and reported **67 findings that were all
   wrong** — 68% of every tool scanned.
2. **WebMCP results are multiply encoded.** `executeTool()` returns
   `{content:[{text:"…"}]}` where the `text` is itself a JSON string, so
   `"isError":true` arrives escaped and every substring check silently misses.
   `unwrap()` peels the layers first.
3. **`unknown` is never reported as `zero`.** Tools register after client-side JS
   runs; probing too early reported three live sites as having no tools when all
   three had 2–4. The probe waits for `load`, settles, and retries transients.

4. **Comparing responses for equality is the wrong test.** The determinism rule
   originally compared two raw responses with `!==`. Almost every live tool then
   looked nondeterministic, because real APIs embed timestamps and request ids —
   the check named a **different tool on every run** of `corpuslaw.us`, which would
   churn a baseline on every run and train people to ignore it. It now compares the
   response *shape* (key paths and types, values discarded), so a timestamp reads
   as `volatile-response` (info) and only a genuinely changed contract reads as a
   defect.
5. **A diff key that dropped the URL** made every pre-existing finding report as
   "fixed", which would have quietly emptied anyone's baseline. Caught by a unit
   test asserting that an identical re-scan produces an empty diff.

`looksLikeRejection()` and `unwrap()` carry comments saying not to simplify them.
They exist because of those exact bugs.

---

## How the report is published

The scan workflow copies `site/` to the root of a `gh-pages` branch and pushes
it. Pages serves that branch with Jekyll disabled (`.nojekyll`).

**There is no OIDC token and no `id-token: write` permission anywhere in this
project.** Two earlier approaches failed and both were abandoned:

- `actions/deploy-pages` requires an OIDC token, and could not obtain one
  (`Unable to get ACTIONS_ID_TOKEN_REQUEST_URL`).
- Serving from `main/site` needs the Pages folder set to `/site`, which the
  settings UI did not offer.

A branch deploy needs neither. The workflow's only write permission is
`contents: write`.

## Requirements

Runs on any Chromium via Playwright — **no Chrome 146 build needed**. The
`@mcp-b/global` polyfill provides `document.modelContext`, injected before page
scripts run.

## What it does not do

- It does not generate WebMCP tools. That is free and automated (`auto-webmcp`,
  393 npm packages keyword-tagged `webmcp`).
- It does not track how your site appears in AI answers. That market is saturated
  and not where the unverified failures are.
- It does not call your tools with real data. Arguments are synthesised from your
  declared `inputSchema`, so add a `default` to any field whose test value would
  be destructive or would hit a real customer.
