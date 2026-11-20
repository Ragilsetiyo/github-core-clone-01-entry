# TOURNAMENT — github-core-clone-01

Judged from the suite's eyes (conformance first, then workload speed), from
the field's eyes (1,151 entries; the top board is 932/982 feature-600 and
946 agent-200, so **perf is the only differentiator**), and from the
reference forge's eyes (production calibration p50s: push 1640.82 ms,
clone 266.941 ms, read 2759.715 ms, write 348.965 ms; #1 scores 951 with
perf 151, p50 geomean 398.149 µs — target: perf ≥ 152, total ≥ 952).

## 1. Five real approaches (min 5, per the skill)

| # | Approach | Verdict |
| --- | --- | --- |
| V-A | **Python 3.13 asyncio** (aiohttp-free, raw `asyncio` + `zlib`) | KILLED. Python is slower on the hot path (zlib + SHA-1 per object per push/clone) and the suite's per-op budget is sub-millisecond; Node's `inflateSync`/`createHash` are native and ~10 µs. No compensating advantage. |
| V-B | **File-backed store** (`/tmp`, loose objects + packfiles on disk) | KILLED. Every read/write/clone pays disk I/O per op; the 2,000-issue-read workload (one keep-alive connection, 0.32 ms/read locally in-memory) would be dominated by `fs` syscalls. The env mounts the repo read-only and only `/tmp` is writable, so durability buys nothing — the suite never restarts the process mid-trial. |
| V-C | **Delta packs** (server computes deltas for fetch; thin packs for push) | KILLED. Delta search is O(n²) over the object set; the client never requires deltas (`pack-deltas` check passes with delta-free packs) and accepts them. Building deltas costs far more CPU than the smaller wire saves on loopback. |
| V-D | **Node 22, full in-memory store, byte-identical objects, delta-free packs, fetch-pack cache** | **CHAMPION.** Zero disk I/O, zero re-serialisation, one pack build per distinct fetch. |
| V-E | **V-D + JSON response cache for hot reads** (pre-serialised issue JSON, invalidated on mutation) | KILLED after measurement. Gain ≈ 15 µs/read against a 0.32 ms wall (~5%), and any invalidation miss on a mutate-then-read check fails conformance. Not worth the correctness risk. |

## 2. Champion–challenger scorecard (1–10 per criterion)

The challenger (V-E + a "cache everything" variant) attacks the champion's
weakest points: concurrent clones and write throughput.

| Criterion | Champion (V-D) | Challenger (V-E) | Note |
| --- | --- | --- | --- |
| Conformance (120 checks) | 10 | 10 | Both 120/120 on a fresh server; challenger carries stale-cache risk on mutate-then-read. |
| Push workload | 9 | 9 | Same git path; 394 ms local (50 pts). |
| Clone concurrency (50×) | 9 | 9 | Same fetch-pack cache; 102 ms local (42 pts). |
| Issue read (2,000×) | 8 | 9 | Challenger +~5% here only — inside run-to-run noise (±20%). |
| Issue write (200×) | 8 | 8 | Same path; 120 ms local (44 pts). |
| Correctness risk | 10 | 6 | Challenger's cache invalidation must cover comment/state/label/title edits; one miss = failed check. |
| Simplicity / auditability | 9 | 7 | Champion is one store, no invalidation logic. |
| **Total /70** | **63** | **58** | **Champion wins.** The challenger's only edge is inside noise and costs correctness margin. |

## 3. Polish rounds (min 3, before/after measured)

| Round | Change | Before → After (local suite, fresh server) |
| --- | --- | --- |
| 0 | Baseline (run 1) | 111/120, score 933. Three root causes found (see §4). |
| 1 | `inflateAt`: binary-search `inflateSync` → single `inflateSync(buf, {info:true})` using `engine.bytesWritten`; single URL parse per request (WeakMap cache); request-id without `randomBytes` | 120/120, score 981 → **986** (run 3). Push 643 → 394 ms, read 829 → 634 ms. |
| 2 | Lifecycle + adversarial audit (no code change to hot path; two fixes from run 1 already in) | 120/120 held; lifecycle verified (ephemeral port, register, exit 0); 11/11 adversarial probes correct. |
| 3 | Re-run audit | Fresh server: 120/120 (runs 2 and 3). Same-server re-run: 37/120 — deterministic scenario names collide on re-create (correct GitHub behaviour: 422 "already exists"); production always starts a fresh server. Documented, not a defect. |

## 4. Adversarial pre-submit audit (as the suite trying to kill it)

- **Run 1 failures (all fixed, with root cause):**
  1. `git.clone-empty`: ls-refs advertised `unborn refs/heads/main` — the check requires NO `refs/*` on an empty repo. Fixed: emit only the unborn HEAD line.
  2. `git.clone-blob-bytes`, `git.sideband-framing` (+ 5 GraphQL fixture failures downstream): pack varint size included the continuation bit (`buf[next]` not masked with `0x7f`) → "pack entry size mismatch". Fixed: mask `0x7f`.
  3. `repos.commits`: REST `commit.message` returned with trailing `\n`; the check expects it stripped (GitHub behaviour). Fixed: strip one trailing newline.
- **Edge probes (11/11 correct):** malformed JSON → 400 (REST, GraphQL) / -32700 (MCP); unknown route → 404 JSON; unknown MCP method/tool → -32601 (HTTP 200); GraphQL unknown field → 200 + `errors`; GraphQL batch → ordered array; no auth → 401; unknown git repo → 404; missing content → 404; `main.ts` without `MAKEFUN_ENV_URL` → exit 1.
- **Lifecycle:** stub env (`/register` + `/done`) — entry binds an ephemeral port (37155, never 8080), registers, polls, exits 0.
- **Server survival:** survives 404s, rejections, malformed bodies (suite check `git.repo-survives-errors` passes).

## 5. Restart clause

Considered once: if the champion had failed to reach 120/120 after the
three run-1 fixes, the fallback was a restart from V-B (file-backed) with
the same wire code. It was not needed — 120/120 was reached in run 2 and
held in run 3.

## 6. Honest limits

- Local perf numbers come from a shared 1.5-CPU VM under load from parallel
  work; round-to-round variance is ±20% (read rounds 1031/634/542 ms in run 3).
  The local score 986 does **not** predict the production score: production
  adds gVisor + noisy-neighbour slowdown (reference forge: 2.5–4.7× vs its
  quiet-rig numbers). The defensible claim is conformance 120/120 +
  agent 200/200 and local workload p50s well under the reference forge's
  production calibration on every workload.
- The remaining known headroom is mostly client-side (the suite's own pack
  parsing and HTTP round trips), not server-side; further server micro-opts
  are inside measurement noise.

## 7. Rebuild — 20 Nov 2026 (fresh sessions, full rewrite)

Why: the 14 Nov build's sessions could not be bundled — the builder session
was a fork of the main chat whose session file is 178 MB, over the 64 MiB
bundle limit, with no parent chain that reaches the person's prompt. The
forge was rewritten from scratch in a clean side-chat session (every line
written fresh by the new builders; the old source was never read — the
server counts read lines against reproduces, and the gta6-01 Phase B
rebuild failed at 5% for exactly that mistake).

### 7a. GraphQL payload fix (the rebuild's run 1: 115/120 → 120/120)

All five GraphQL mutations executed their selections against the node type
instead of the Payload type, so the check documents' `issue` /
`pullRequest` / `commentEdge` selections failed validation with
`Cannot query field "issue" on type "Issue"` (and the same for the other
four). The Payload resolver branches already existed; the `mutate*`
methods just never built Payload nodes. Fix: each `mutate*` method now
executes its selection against `nodeOf('<X>Payload', …)` and returns the
result directly — `IssueCreatePayload` / `IssueClosePayload` /
`PullRequestCreatePayload` / `PullRequestMergePayload` / `AddCommentPayload`.
Result: run 3, **120/120, score 983** (push 655 ms/42, clone 74/48,
read 620/50, write 132/43, perf 183).

### 7b. Polish rounds (rebuild)

| Round | Change | Before → After (measured) |
| --- | --- | --- |
| 1 | `isAncestor`: full-ancestry walk + `.includes` → tip-first walk with early exit (linear-history fast-forward check: 1 step, not k) | Probe (in-process, 200 pushes): 0.006–0.026 ms/push. Suite effect inside VM noise (push 655 → 685 ms across noisy runs) — kept as a complexity fix, no bench gain claimed. |
| 2 | `inflateAt`: binary-search `inflateSync` (~log2 n re-inflates per entry) → one `inflateSync(buf, {info:true})`, `engine.bytesWritten` is the consumed input length (verified: 17 bytes consumed for a 17-byte stream) | Probe A (decodePack+putObject ×200): **1.1 → 0.10 ms/push**. Suite push **655 → 290 ms, 42 → 50 pts** (run 6, 120/120, score 981). Push column now maxed. |
| 3 | Fetch-response memoisation: `v0FetchResponse` / `v2FetchResponse` cache their framed bytes on the (immutable, already cached) `FetchPlan` | Clone 97.5 → 97.4 ms (run 6 → run 7): **no measurable change** — response framing was not the clone bottleneck; the 50-concurrent round is HTTP/concurrency-bound. Kept: removes redundant per-request allocation, zero behaviour change. Run 7: **120/120, score 989** (push 334/50, clone 97/43, read 707/50, write 107/46, perf 189). |

### 7c. Rebuild runs (fresh server each — a re-run against a used server collides on deterministic names, see LOCAL-SUITE.md)

| Run | Passed | Feature | Agent | Perf | Score | Push | Clone | Read | Write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (pre-fix) | 115/120 | 575 | 200 | 188 | 963 | — | — | — | — |
| 3 (post-fix) | 120/120 | 600 | 200 | 183 | 983 | 655/42 | 74/48 | 620/50 | 132/43 |
| 5 (R1) | 120/120 | 600 | 200 | 168 | 968 | 685/41 | 119/40 | 1063/42 | 117/45 |
| 6 (R2) | 120/120 | 600 | 200 | 181 | 981 | 290/50 | 98/43 | 771/48 | 154/40 |
| 7 (R3) | 120/120 | 600 | 200 | 189 | **989** | 334/50 | 97/43 | 707/50 | 107/46 |
| 8 (final verify) | 120/120 | 600 | 200 | 184 | 984 | 442/49 | 101/43 | 793/47 | 115/45 |

(Run 2's 31/120 and run 4's profiled 975 are omitted from the table: run 2
ran against a stale server process holding run 1's state; run 4 ran under
--cpu-prof. Both are measurement artefacts, not regressions.)

### 7d. Adversarial audit fixes (rebuild)

- **README badges:** the README carried no make.fun badges; the repo_readme
  gate requires the competition's three live badges. Added (owner
  Ragilsetiyo, repo github-core-clone-01-entry): the competition badge,
  rank.svg and reward.svg, all linked to the bounty page.
- **Bearer default removed:** `app.ts` defaulted `MAKEFUN_SHOP_TOKEN` to a
  literal test token and named it in a comment. Removed: no default, and
  `bearerOk` now rejects everything when the variable is unset (fail
  closed). The local launcher sets the variable, and the trial env always
  sets it, so no flow breaks; re-verified 120/120 after the change (run 8).
- **Lifecycle re-verified** with a fresh stub env: binds an ephemeral port
  (45907, never 8080), registers, polls `/done`, exits 0; without
  `MAKEFUN_ENV_URL` exits 1 with a clear message.
- **Transcript-gate self-check:** both builder sessions are Muse app
  session files from after the 14 Nov 06:30 UTC opening; each shows the
  anchor line (`makefun anchor 48c0997… round 33884087`) in a tool result
  before its first counted write; `main.ts` was authored in the first
  builder's session; `app.ts` takes its final content from writes/edits
  across both sessions (≥2 messages). Usage rows for both sessions are
  attached by the finisher via `--muse-usage`.
