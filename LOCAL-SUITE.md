# LOCAL-SUITE — github-core-clone-01

Runner: the kit's own local conformance runner, which is the same suite
sealed in the env (`sdk/run.ts`, `sdk/conformance/` byte-identical to
`program/env/src/`). Command used for every run below:

```sh
node --experimental-strip-types sdk/run.ts \
  --url http://127.0.0.1:18099 --token test-token-123 --perf --json
```

Server: `node --experimental-strip-types /tmp/run-local.mjs 18099`
(a thin launcher that calls `createApp()` from `app.ts`; `main.ts` needs a
real env URL, so it is tested separately — see §3). Token
`test-token-123` is a throwaway local token, not a real credential.

## Results

| Run | Server | Passed | Feature | Agent | Perf | Score | p50 geomean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | fresh, pre-fix | 111/120 | 555 | 200 | 178 | 933 | 276.040 µs |
| 2 | fresh, post-fix | **120/120** | 600 | 200 | 181 | 981 | 262.329 µs |
| 3 | fresh, post-polish-1 | **120/120** | 600 | 200 | 186 | 986 | 234.983 µs |
| 4 | **same server as run 3** (re-run) | 37/120 | 185 | 133 | 179 | 497 | 270.926 µs |

Per-group (runs 2 and 3): git 30/30, repos 15/15, issues 15/15,
pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15.

### Workload p50s (ms, 3 timed rounds + 5 warm-ups each)

| Workload | Run 1 | Run 2 | Run 3 | Run 4 | Reference forge (production calibration) |
| --- | --- | --- | --- | --- | --- |
| push (200) | 614 | 643 | **394** [448, 394, 359] | 440 [528, 440, 435] | 1640.82 |
| clone (50 concurrent) | 106 | 77 | **102** [117, 102, 78] | 81 [118, 81, 74] | 266.941 |
| read (2,000) | 846 | 829 | **634** [1031, 634, 542] | 875 [926, 875, 729] | 2759.715 |
| write (200) | 106 | 115 | **120** [170, 120, 87] | 172 [109, 172, 219] | 348.965 |

Points per workload in run 3: push 50, clone 42, read 50, write 44
(perf 186/200). Local points are computed against the production
calibration constants, so they overstate the production score — this VM
(shared 1.5 CPU) is faster per-op than a production gVisor pod, and
round-to-round variance is ±20% (see the read rounds in run 3). The
numbers are a regression signal, not a production prediction.

## Run 1 failures (all fixed — see TOURNAMENT.md §4)

1. `git.clone-empty` — ls-refs advertised `unborn refs/heads/main`; fixed to
   emit only the unborn HEAD line.
2. `git.clone-blob-bytes`, `git.sideband-framing` — pack varint size bug
   (continuation bit not masked); the same bug broke 5 GraphQL fixture
   pushes. Fixed in `git.ts`.
3. `repos.commits` — `commit.message` kept a trailing `\n`; stripped.

## Run 4 note (37/120 is NOT a regression)

Run 4 re-ran the suite against the server that had already served run 3.
The scenario uses deterministic names (fixed seed `0x6a09e667f3bcc909`),
so every repo create returned 422 "already exists" and every setup push
hit "refs/heads/main: already exists". That is correct GitHub behaviour;
production always starts a fresh server per trial. The one non-collision
failure (`graphql.issues-pagination`, second page 5 nodes vs 2) is the same
cause: the lazy GraphQL fixture repo already held run 3's issues.
The benchmark workloads in run 4 still ran normally (push 440, clone 81,
read 875, write 172 ms) because they use their own repos.

## Lifecycle test (stub env, §3)

Stub env implementing `POST /register` and `GET /done` on port 18090.
`main.ts` with `MAKEFUN_ENV_URL=http://127.0.0.1:18090`: bound ephemeral
port 37155, registered, polled `/done`, exited 0. Without
`MAKEFUN_ENV_URL`: exit 1 with a clear stderr message.

## Adversarial probes (11/11 correct)

Malformed JSON → 400 (REST/GraphQL), -32700 (MCP); unknown route → 404;
unknown MCP method/tool → -32601 over HTTP 200; GraphQL unknown field →
200 + `errors`; GraphQL batch → ordered array; no auth → 401; unknown git
repo → 404; missing content → 404. Full output in TOURNAMENT.md §4.
