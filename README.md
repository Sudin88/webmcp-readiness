# webmcp-readiness

Verify the WebMCP tools your site exposes to AI agents — in CI, before they ship.

The [WebMCP spec](https://webmcp-registry.dev) landed **30 September 2026**. Chrome 146 ships
it in early preview and ChatGPT's in-app browser supports it. An independent scan of the public
registry found:

- **0 of 114** observable tools declare what they return — and they can't, because
  `outputSchema` doesn't exist in the spec yet ([issue #9](https://github.com/webmachinelearning/webmcp/issues/9))
- **8 tools throw** on input that satisfies their own declared schema
- **4 registry entries advertise tools that do not exist** on the page (one claims 29)
- **9 tools** declare input fields with no description, so the model has to guess the format

None of it is visible, because nothing checks it. Generation is free and automated
(`auto-webmcp`, 393 npm packages keyword-tagged `webmcp`); verification is manual.

**[Read the full report →](REPORT.md)**

---

## Use it as a GitHub Action

```yaml
name: webmcp
on: [push, pull_request]

jobs:
  readiness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: <owner>/webmcp-readiness@v1
        with:
          config: webmcp.config.json
```

`webmcp.config.json`:

```json
{ "urls": ["https://your-app.example"] }
```

Findings land as inline annotations on the PR diff. See **[ACTION.md](ACTION.md)** for inputs,
outputs, baseline adoption, and what each rule is derived from.

### Adopting it without a wall of red

A first run fails on whatever already exists. To accept current state and fail only on
*new* breakage:

```yaml
      - uses: <owner>/webmcp-readiness@v1
        with:
          update-baseline: true   # one-off, then remove
```

It prints every finding it absorbs, one per line, so the diff is reviewable.

**A tool that disappears fails the build.** If something in your baseline is no longer
registered, an agent that called it yesterday breaks today. That is a regression, not a fix,
and it is not baselined away silently.

## Run it locally

```sh
npm install
npx playwright install chromium

# check your own site
echo '{ "urls": ["https://your-app.example"] }' > webmcp.config.json
node action/index.mjs

# or scan the whole public registry and rebuild the report
npm run scan && node build-site.mjs

npm test    # 36 unit + integration tests, no network needed
```

## How it works

```
lib/checks.mjs   the rules, and the severity model
lib/probe.mjs    Playwright + @mcp-b/global, so no Chrome 146 build is needed
lib/diff.mjs     baseline diffing
action/index.mjs CI entry point
scan.mjs         registry-wide scan
build-site.mjs   static report generator
fixture/         a page seeded with known defects, used by the tests
```

Every rule is taken from the spec's own guidance rather than invented. The rules deliberately
do **not** fail the build when an implementer cannot act — `outputSchema` is reported as `info`
because it is unfixable until the spec lands, and a check that fails you on a spec gap trains
you to disable it.

## On false positives

A verification tool that produces false positives is worse than none. Three bugs we hit while
building the baseline scanner are documented in [REPORT.md](REPORT.md) because the first two
produced **67 findings that were all wrong**:

- **Transport success is not input acceptance.** A tool that correctly rejects bad input
  usually returns `{"isError": true}`, not an exception.
- **WebMCP results are multiply encoded**, so `"isError":true` arrives escaped and substring
  checks silently miss.
- **"I did not look in time" is not "there is nothing there."** A zero result is re-probed with
  fresh browser contexts before it is believed.
- **Comparing responses for equality is the wrong test** — a timestamp is not a broken
  contract. Responses are compared by *shape*.

## What this does not do

- It does not generate WebMCP tools. That is free and automated.
- It does not track how you appear in AI answers. That market is saturated and not where the
  unverified failures are.
- It does not call your tools with real data. Arguments are synthesised from your declared
  `inputSchema`, so **add a `default` to any field whose test value would be destructive or
  would reach a real customer.**

## License

MIT