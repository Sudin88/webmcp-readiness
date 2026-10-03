# Draft — comment on webmachinelearning/webmcp#9

**Do not post as-is.** Edit into your voice first. A contribution that reads as
generated gets ignored, and this one is worth reading. Trim whatever you didn't
personally verify — the credibility of the whole comment rests on the data being
real, and if you didn't run it yourself, say so or drop it.

Post at: https://github.com/webmachinelearning/webmcp/issues/9
(3 comments so far; the resolution from @domfarolino's 5 Feb 2026 minutes is in
comment 3, so this is implementation input rather than a fresh proposal.)

---

Since the February resolution, here's what an implementation needs to contend
with. I scanned the public registry on 2 Oct 2026 — 40 listed entries, 235 tools
claimed, **120 tools actually observable across 13 sites**. Every one of them
returned free text with no declared return type, because the field didn't exist
yet to declare.

Two things that shaped the design:

## 1. Returned values are frequently not JSON

The explainer's own example returns prose in `content[0].text`. Real tools are
worse: nested JSON arrives *stringified inside* that text, sometimes escaped
twice. Comparing responses naively produced 67 false positives out of 98 tools on
my first attempt — `{"isError":true}` arrives as `\"isError\":true` and every
substring check silently misses. A validator that assumes a parseable payload
will be wrong on the majority of the current web.

Suggest treating a failed parse as *unverifiable*, not as a violation. Otherwise
every existing tool becomes non-conformant the day the field ships, and nobody
adopts it.

## 2. A return contract only helps if it's enforced against reality

8 of the 120 tools throw when called with arguments that satisfy their own
declared `inputSchema`. Examples from `proxy-compare.com`:

```
list_proxy_providers  → "Invalid volumeGb; see the tool input schema."
list_recorded_changes → "Invalid since; see the tool input schema."
```

The error tells the agent to consult a schema it already satisfied. An
`outputSchema` that isn't checked at call time reproduces the same trap on the
response side.

## Proposed shape, matching MCP

Mirroring [MCP's `outputSchema`](https://modelcontextocol.io/specification/2025-06-18/server/tools#tool)
means no new concepts — but two behaviours are worth writing into the explainer:

- **Strict output validation, loose input validation.** The existing guidance is
  already "validate strictly in code, loosely in schema." The same split is what
  keeps agents retrying instead of stalling.
- **Expose shape, discard values.** Responses vary legitimately — timestamps,
  request ids. Comparing key paths and types with scalar values discarded
  separates "the contract changed between calls" (a real defect) from "the data
  moved" (normal). Otherwise the check flags noise and gets switched off.

## A falsifiable claim

The thing that would actually change agent reliability is **measured**, not
asserted: does declaring and validating `outputSchema` reduce failed agent
sessions?

I can contribute a harness that measures it: ~900 lines, Playwright plus the
`@mcp-b/global` polyfill so it runs against any Chromium, emitting per-tool
`getTools()`/`executeTool()` traces against a specified corpus. It already exists
as a working CI Action.

What I can't do is answer the question myself — that needs an agent harness and
a task corpus, and the polyfill means I'm testing against my own instrumentation
rather than a shipping browser agent. Happy to work on the harness if the
group wants it.

Two things I'd want settled before implementing, both raised in comment 2 and
still open:

- **Declarative form.** If output validation applies to declarative tools, is it
  on the `<form>` element or inferred? Comment 2 suggests an attribute; I'd like
  confirmation before implementing against it.
- **Cross-document results.** Comment 2 flags this as needing thought. A tool
  that navigates can never produce a schema-valid body, so this likely needs an
  explicit "unverifiable" path rather than a validation failure.

Happy to be assigned either, or to start with the reference validator and tests
for the imperative API.

---

## Editor's notes

- **Verify the numbers before posting.** 40 entries / 235 claimed / 120 observed /
  13 sites / 120 of 120 without a return contract / 8 throwing. All from
  `scan-results.json` in this repo — but check them against
  `npm run scan` if you want to be certain.
- **The 67-of-98 detail is the strongest thing in the comment.** It's the kind of
  failure that proves the tooling was actually run rather than sketched. Keep it
  if you can vouch for it.
- **Don't overclaim.** You can't measure agent reliability yet. Offering the
  harness is stronger than pretending to the answer.
- **The limitation paragraph is deliberate** — admitting the polyfill caveat
  makes the rest more credible, not less. Don't cut it.
- **Link the repo.** Once the workflow runs cleanly for a week, the trend table
  is the evidence base.