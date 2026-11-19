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
