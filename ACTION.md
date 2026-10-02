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
| Tool returned different output for identical input | medium | agents cannot verify what they cannot reproduce |
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

`looksLikeRejection()` and `unwrap()` carry comments saying not to simplify them.
They exist because of those exact bugs.

---

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
