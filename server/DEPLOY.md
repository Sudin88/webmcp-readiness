# Deployment

This service opens pages chosen by anonymous visitors in a real browser, from
inside your network. That is the whole risk profile. Read the "Launch blockers"
before deploying.

## Launch blockers

### 1. Egress filtering (not a code fix — the control that actually closes SSRF)

`server/safety.mjs` validates a hostname and checks the addresses it resolves to.
Chromium then resolves **again, independently**, and opens the socket. Nothing
binds the validated address to the connection, so **DNS rebinding still works at
the application layer.** A reviewer reproduced full credential exfiltration this
way.

The control that closes it is at the network layer, because it applies after
Chromium has already resolved:

```
ALLOW  outbound  tcp/443, tcp/80        to the internet
BLOCK  outbound  to 10.0.0.0/8
BLOCK  outbound  to 172.16.0.0/12
BLOCK  outbound  to 192.168.0.0/16
BLOCK  outbound  to 127.0.0.0/8
BLOCK  outbound  to 169.254.0.0/16     # includes 169.254.169.254 metadata
BLOCK  outbound  to ::1/128
BLOCK  outbound  to fc00::/7
BLOCK  outbound  to fe80::/10
```

Equivalent `fly.toml` shape (verify against current Fly docs before relying on
it — network config changes):

```toml
[http_service]
  internal_port = 8080
  auto_stop_machines = "suspend"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  memory = "2gb"
  cpu_kind = "shared"
  cpus = 2

# Chromium needs a bigger /dev/shm than the default.
[[services.containers]]
  ...
```

On Railway/Render: use their private networking egress rules, or run the browser
in a container whose only route is 80/443 outbound.

**Do not launch without this.** The application guard is defence in depth, not
the last line.

### 2. Chromium's sandbox must stay on

`server/scan.mjs` launches with `chromiumSandbox: true` and no `--no-sandbox`.
That is deliberate: the renderer executes anonymous visitors' JavaScript, so the
sandbox is the only boundary between them and the host. `--disable-dev-shm-usage`
is a container concern and safe to keep.

If the sandbox will not start on your platform, fix the platform (user
namespaces, seccomp) — do not disable the sandbox.

### 3. Run as non-root, with limits

```dockerfile
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund
COPY server ./server
COPY web ./web
COPY lib ./lib

ENV NODE_ENV=production PORT=8080
USER pwuser                      # the image's unprivileged user
EXPOSE 8080
CMD ["node", "server/index.mjs"]
```

Launch with `--init` (reaps orphaned Chromium processes), a CPU cap, and a
memory cap. Chromium contexts are memory-hungry; `MAX_CONCURRENT = 3` is a guess
until measured — see the load test below.

## Measured capacity

Benchmarked locally at MAX_CONCURRENT=3:

| Target | Cost | Ceiling |
|---|---|---|
| Page with no WebMCP | ~6.2 s | ~1,510 scans/hour |
| Page with 3 fast tools | ~6.5 s | ~1,430 scans/hour |
| Page with 12 slow tools | ~24 s | ~446 scans/hour |

Throughput saturates at concurrency 4 (0.425 rps) and degrades linearly beyond it,
refusing rather than queueing without bound. A 64-request burst produced 13
admitted + 51 refused in tens of milliseconds, `/healthz` stayed at 0.4 ms, and
the next request succeeded in 6.4 s: full recovery, no degradation residue.

**97% of a cheap scan is the fixed 6 s settle**, not navigation (~0.2 s) or tool
calls. Cutting `SETTLE` to 3 s would roughly double capacity; the existing
`confirmNoTools` retry is the safety net for sites that register late. Left at 6 s
because a false "no tools" verdict is worse than a slow one.

Memory: ~132 MB per context, ~890 MB at 3 concurrent. No leak observed over 250
scans including hostile pages; RSS stayed flat at 587-623 MB.

## Sandbox prerequisite (verified failure)

On a host with `kernel.apparmor_restrict_unprivileged_userns=1`, Chromium in this
image fails to start at all:

```
FATAL:zygote_host_impl_linux.cc:129] No usable sandbox!
```

Every scan then returns 500 while `/healthz` still returns 200. The healthcheck now
launches Chromium for exactly this reason. Before launch, verify a real scan
succeeds inside the image.

## Tuning

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `SCAN_TIMEOUT_MS` | `45000` | navigation timeout |
| `RATE_BURST` | `3` | per-IP burst |
| `RATE_REFILL` | `0.0167` | per-IP tokens per second (1 per 20s) |
| `RATE_DAILY` | `50` | per-IP daily cap |
| `RATE_INFLIGHT` | `1` | per-IP concurrent scans |
| `RATE_FLEET_BURST` | `20` | burst across all clients |
| `RATE_FLEET_REFILL` | `0.25` | fleet tokens per second (1 per 4s). Raised from 1/6s, which capped throughput at 600/h against a measured mixed ceiling of ~990/h |
| `TRUST_PROXY` | unset | set to `1` ONLY behind exactly one proxy that overwrites `x-forwarded-for`. Honouring it by default lets a client choose its own identity and opt out of every per-IP limit |
| `MAX_CONCURRENT` | `3` | env-tunable; ~132 MB per context |
| `EXPOSE_STATS` | unset | set to `1` to expose `/__stats` (reconnaissance aid; leave off) |

**Capacity math.** 3 slots × 45s worst case ≈ **240 scans/hour** is the ceiling.
The fleet ceiling is set well below that because that is what actually bounds
CPU. After changing limits, re-run the load test.

## Measured behaviour

From `server/scan.mjs` against live sites, single browser, 3 slots:

- proxy-compare.com — 16 tools, 6 high findings, ~9s
- 4 concurrent scans across different sites — 27s wall clock
- 1 browser reused across all scans; contexts are per-request

## Before you go live

- [ ] Egress rules in place (blocker 1)
- [ ] Sandbox verified on with a non-root user (blocker 2)
- [ ] `npm audit --audit-level=high` clean — CI currently passes `--no-audit`
- [ ] Exact dependency pins in `package.json`, not carets
- [ ] `/healthz` wired into the platform's health check
- [ ] Rate limits set for the host's actual CPU budget
- [ ] Load test run at the intended concurrency

## What this service deliberately does not do

No accounts, no database, no cookies, no analytics, no third-party requests.
The CSP is `default-src 'none'` and no `Access-Control-Allow-Origin` is sent —
with no cookies there is nothing for a hostile origin to steal, so same-origin is
the correct and sufficient posture.