# The State of the Agent-Readable Web

**Scan date:** 2 October 2026 · **Spec:** WebMCP Draft Community Group Report, 30 Sep 2026
**Method:** Playwright + `@mcp-b/global` v5.1.0 · 40 registry entries · 589s · source: `scan.mjs`

> The WebMCP spec landed three days ago. This is the first independent verification pass over
> the public WebMCP registry. Reproduce it yourself: `node scan.mjs`.

---

## Headline

**The registry lists 235 tools. We observed 114. Zero of them declare what they return.**

| | |
|---|---|
| Registry entries scanned | 40 |
| Tools the registry claims | 235 |
| Tools actually observable | **114** (48%) |
| Tools declaring an `outputSchema` | **0 of 114 (0%)** |
| Tools that declare *any* return contract | **0** |

`outputSchema` does not exist in the spec yet — it is [open issue #9](https://github.com/webmachinelearning/webmcp/issues/9).
Until it lands, **no WebMCP tool on the public internet declares a verifiable return type.** Every
agent call is a bet that the response matches the description.

---

## 1. Half the registry is unobservable

| Outcome | Entries | What it means |
|---|---|---|
| Tools observable | 33 | We could discover and read the page's tools |
| Listed, zero tools found | 4 | Registry lists tools; page registers none |
| Unreachable | 3 | Could not load reliably from this network |

Four entries are listed in the registry but expose no tools at all:

| Registry entry | Registry claims | Observed |
|---|---|---|
| `agentk.stacktr.ee` | **29 tools** | 0 |
| `spectrumtours.cz` | **9 tools** | 0 |
| `demos/pizza-maker` (Chrome Labs) | **7 tools** | 0 |
| `settledestate.com` | **3 tools** | 0 |

`agentk.stacktr.ee` is the largest single discrepancy: the registry advertises 29 agent tools on
that domain, and an agent visiting the page finds nothing. Either the registry is stale or the
site regressed. **Nothing in the current toolchain would ever notice.**

---

## 2. Every tool has an unverifiable output contract

**114 of 114 tools** lack an `outputSchema`. The spec is candid about why — the field does not
exist yet — but the practical consequence is severe and invisible:

- A tool's `description` is the *only* thing an agent knows about what comes back.
- `description` is free text. Nothing checks it against reality.
- The polyfill returns whatever the page's `execute()` returns, with no shape validation.

**Failure mode:** a tool promises `{orderId: string}`, returns `"null"` on the second call, and
the agent confidently reports success. We built this exact case into our own test fixture to
confirm the probe catches it. It does. In the wild, nothing does.

---

## 3. Tools that fail on input that satisfies their own schema

**8 tools** throw on arguments that pass their declared `inputSchema`. All on two hosts:

`www.proxy-compare.com` (6 of 16 tools) — the same pattern repeatedly:

```
list_proxy_providers  → UnknownError: ... Invalid volumeGb; see the tool input schema.
compare_provider_details → UnknownError: ... Invalid providerSlugs; see the tool input schema.
read_site_guide       → UnknownError: ... Invalid path; see the tool input schema.
list_recorded_changes → UnknownError: ... Invalid since; see the tool input schema.
get_provider_details  → UnknownError: ... Unknown provider ID. Use find_providers first.
list_browser_plans    → UnknownError: ... Choose USD or EUR before setting maxPrice.
```

The error text literally says *"see the tool input schema"* — and we **did** send schema-valid
input, because the probe synthesises arguments strictly from the declared schema. The schema
under-describes the real constraints. An agent has no way to discover the true rule except by
failing.

`demos/webmcp-maze` (`start_game`) and `demos/french-bistro` (`book_table_le_petit_bistro`) also
throw; the latter rejects a *declarative form* parameter, which means its declarative and
imperative definitions disagree.

---

## 4. Undocumented schema fields

**9 tools** declare at least one input parameter with no `description`. The spec's own guidance:

> "Document schemas with descriptions — Provide helpful `description` fields on all input
> parameters in `inputSchema` to help the agent supply appropriate values."

Without one, the model must guess the expected format — units, format, whether a bare ID or a
full URL. Affects `taxsaleatlas.com` (5 tools), `proxy-compare.com`, `simpletoolstack.com`, and
two Chrome Labs demos.

---

## 5. Required fields are, in practice, enforced

Only **6 of 114** tools accept a call that omits a field declared in `required` — all six are
Chrome Labs reference demos (`get_order_status`, `lookup_amenity`, `search_location`,
`rearrangeDOMComponents`, `reorder_product`, `search_property_location`).

This is the one encouraging result in the scan: implementers are validating properly. It is also
the **hardest check to automate correctly** — see the methodology note below, where a naive
version of this test produced 67 false positives before we fixed it. A tool rejecting bad input
usually returns an error *in the payload* rather than throwing, so "did not throw" is not
evidence of "did not validate."

---

## 6. Tool budget

`www.proxy-compare.com` registers **16 tools** on one page. The spec warns:

> "Every registered tool... consumes tokens in the model prompt, adds to inference latency, and
> increases the potential for tool confusion or hallucination. Exposing too many tools... can
> severely degrade agent performance."

16 is a warning, not a crisis — the spec's advice is to register dynamically by page state, which
this site does not appear to do. One domain to fix, low severity, and a good demonstration that
the budget is a real lever.

---

## Why nobody noticed any of this

Because checking requires exactly the thing nobody has built: a harness that can *discover* tools
on a page, *call* them with schema-valid arguments, *repeat* the call to detect nondeterminism,
and then check the response against what the tool claimed. Generation is free and automated
(`auto-webmcp`, 393 npm packages keyword-tagged `webmcp`). Verification is manual.

The asymmetry is the opportunity. The registry will keep growing while nothing measures it.

---

## Methodology, and three bugs we hit doing it

Reported because a verification tool that produces false positives is worse than none, and two of
these would have inflated the headline defect counts roughly 10x.

1. **Transport success is not input acceptance.** A tool that correctly rejects a call usually
   returns `{"isError": true, ...}` or `{"error": "..."}` rather than throwing. Our first detector
   only checked for exceptions and reported **67 unenforced-required-fields findings — 68% of all
   tools. All false positives.** `corpuslaw.us` and `b2a.bluepillow.com` were both verified
   correct in a manual re-check.
2. **WebMCP results are multiply encoded.** `executeTool()` returns `{content:[{text:"..."}]}`,
   and the `text` is itself usually a JSON *string*. Stringifying that once means `"isError":true`
   arrives as `\"isError\":true` and every substring check silently misses. Fixed by peeling
   JSON layers before matching. This cut the count from 67 → 48 → 6, with unit tests covering
   four rejection shapes and two genuine accepts.
3. **`domcontentloaded` is too early, and flakiness is not a verdict.** Tools register after
   client-side JS runs. Probing at `domcontentloaded`+4s reported three live sites
   (`settledestate.com`, `airportloungelist.com`, `hopi.co.uk`) as having **zero** tools; all
   three have 2–4. `load` + 6s settle + three retries corrected the record. A harness that
   reports "no tools" when it means "I didn't look in time" is a trap, so `unknown` is now
   reported as a distinct outcome from zero.

The three `unreachable` entries in the table above are this same class of artifact and may still
be reachable from other networks; we did not confirm them from a second region.

**Reproduce:** `node fetch-registry.mjs && node scan.mjs`. The scan is read-only — it loads public
pages, reads declared tool metadata, and invokes each tool with schema-synthesised arguments.

---

## What a fix looks like

Three are actionable by any site today:

1. **Add an `outputSchema`** to every tool (and push the spec to land issue #9). A tool that
   declares its return type can be checked automatically; a tool that does not cannot.
2. **Document every schema field**, with units and format. 9 tools are guessing today.
3. **Make schema and implementation agree** where they currently disagree — 8 tools reject
   schema-valid input, and the errors point back at a schema that is already wrong.

One is a registry problem: entries advertising tools that do not exist should be verified
automatically on submission, not discovered by users.
