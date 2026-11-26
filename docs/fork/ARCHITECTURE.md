# System architecture: ZCode fork + Telegram bot

> This document is the master map. The operational runbook lives in
> [`FORK.md`](../../FORK.md) (repo root) and the testing strategy in
> [`TESTING.md`](./TESTING.md). Everything described here is the real state as of
> 2026-11-02, verified against code and logs — not aspirational.
>
> **Update 2026-11-02:** the Python bot described in §1/§2/§4 is
> **retired** since 2026-10-30. The live bot is the Kotlin daemon of
> `zcode-bot-kotlin` (`~/.zcode/bot-daemon`, LaunchAgent
> `com.zcode.bot-daemon`): it speaks the fork's daemon-local channel and is the
> sole owner of getUpdates. The `bot` repo remains as the parity reference
> and rollback gate. The Python bot sections are kept as
> design and migration history.

## 1. What this system is (in 60 seconds)

Two pieces that cooperate on Damian's Mac:

1. **The ZCode fork** (this repo, `damian` branch = upstream `main` + 26+
   `[fork]` commits): the desktop app Damian uses, built from
   source and installed at `/Applications/ZCode.app`. It survives z.ai's
   gateway 502s, shows honest retry states with a countdown
   timer, and exposes live telemetry that the bot consumes.
2. **The Telegram bot** (`~/.zcode/hooks/zcode_bot/`, Python package
   ~15k lines): remote control from the phone. It notifies everything that
   happens in ZCode (turns, permissions, questions, failures), lets you answer
   permissions from the phone, runs its own **headless** turns, and shows the
   work live (CoT, subagents in small boxes, tool-args streaming).

The boundary between them: **JSONL sidecar files and logs** in `~/.zcode/`.
The fork writes facts; the bot reads them. There is no internal API — any
process can read a file, and a file survives both.

## 2. Component map

```
┌───────────────────────── /Applications/ZCode.app (fork build) ─────────────────────────────┐
│                                                                                             │
│  Main (Electron)                                                                            │
│   ├─ desktopRuntimeEnv.ts ── Host env: JITTER=0, MAX_DELAY=1024000 (Wave 4/7),              │
│   │                          DYNAMIC_WORKFLOW_MODE=alwaysOn in production (Wave 8)          │
│   └─ swap with rename semantics (mv .prev + ditto + codesign)                               │
│                                                                                             │
│  Host (utility process) — packages/services                                                 │
│   ├─ zcodeAgentService ──── agent spawn + policy sync (dynamic workflow, off-peak)          │
│   ├─ forkModelRetrySpawnEnv ── injects retry defaults ONLY if the user did not set them     │
│   ├─ codingPlanSubscription ── zcode.z.ai client/configs (fail-closed; Wave 8 defeats it)   │
│   └─ daemonChannel (B3a) ── unix socket ~/.zcode/daemon-local.sock: inbound as the composer │
│                             path + bot-channel-continuous stream + queries                  │
│                             (ADR-022; spec: docs/fork/DAEMON-CHANNEL.md)                    │
│                                                                                             │
│  Renderer (app.asar) — packages/ui                                                          │
│   ├─ chat pill: toRetryStatus → ChatApiRetryStatus (labels per reason + countdown)          │
│   └─ two surfaces for the same state (Wave 6b lesson: always verify both)                   │
└──────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                           │ spawn (fork env) + stdio protocol
                                           ▼
┌───────────────────────── CLI agent (Resources/glm/zcode.cjs) ──────────────────────────────┐
│  adapters ── retry-policy (pure 2^n curve), failure-classifier (z.ai codes +                │
│              next_flush_time), runner-retry (calculateRetryDelay), request-admission        │
│  core ────── turn loop, stream recovery (budget per CONSECUTIVE failures), model-status     │
│  bootstrap ── product-projection v4 (ApiRetryState: nextRetryAt + raw reason)               │
│                                                                                             │
│  Writes: ~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl  (post-mortem diagnosis)                   │
│  Writes: <workspace>/.zcode/live-io-<session>.jsonl  (LIVE sidecar: CoT + tool-args)        │
└──────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                           │ api.z.ai (SSE; 502 in waves) / zcode.z.ai (configs)
                                           ▼
                                    (network — the only thing we do not control)

┌───────────────────────── Bot: ~/.zcode/hooks/zcode_bot/ ───────────────────────────────────┐
│  LaunchAgents (3): telegram-watch (app events), telegram-cmds (command loop),               │
│                     bot-healer (channel watchdog)                                           │
│                                                                                             │
│  gateway.py (18-line facade — the package is the implementation)                            │
│   ├─ poller ─────── loop async driver: long-poll 3s, at-least-once (F2d)                    │
│   ├─ dispatcher ─── the ONLY update processor: serial + dedup by update_id (ADR-001)        │
│   ├─ commands/ ──── Telegram handlers (/task, /stop, /nuclear, menus…)                      │
│   ├─ workers ────── headless turns: bot-queue.json → prompt_worker as a SEPARATE PROCESS    │
│   │                 (F16: real isolation — /nuclear kills the turn, not the bot)            │
│   ├─ live_io ────── reads the fork's live-io-<sid>.jsonl sidecars (F73)                     │
│   ├─ agent_live ─── the Progress agent N.M boxes: each subagent's internal work             │
│   │                 (F63; fed by the sidecars the fork commits)                             │
│   ├─ spectator ──── the Mac's turns live on Telegram (F33)                                  │
│   ├─ attach ─────── /task hooks onto the turn ALREADY running (F62)                         │
│   ├─ nuclear ────── ☢️ announced and verified restart of the stack (F4e)                    │
│   ├─ healer ─────── CONTRACT watchdog: if a turn runs and nobody delivers, it acts (F79c)   │
│   └─ circuit_breaker / rate_limiter / concurrency ── channel defenses                       │
│                                                                                             │
│  State: ~/.zcode/hooks/state/ · Per-hot-fix backups: ~/.zcode/hooks/backups/                │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Why the bot is headless

- **Real process isolation.** Each turn from the phone runs in
  `prompt_worker` as a **separate subprocess** (F16), not inside the bot or
  the app. `/nuclear` or a crash kills that turn; the command loop and the
  Mac app stay alive. The queue (`bot-queue.json`) survives everything.
- **It does not depend on the UI.** Turns use the agent's CLI runtime
  (the same `zcode.cjs` from the bundle) with the session persisted in
  `~/.zcode/` — the phone "is" another client of the same session, not a
  remote control for screens. Permissions have their own headless flow.
- **The bot can monitor and operate the app without being inside it.**
  Events arrive through ZCode hooks (`watch-app`), states through the
  sidecars/logs. That is why the bot keeps working when the app hangs,
  updates itself or is in ⌘Q.

## 4. The fork's design patterns (with the commit that introduces them)

These are the principles that repeat across the 26 commits. They are the rules
to follow for future changes (also in [`FORK.md §Deploy`](../../FORK.md)).

### 4.1 Fixed tables and deterministic curves — never an open "n/10"
`2b2d17a0` (highspeed: fixed `[1s, 3s]`), `f85a67f6` (pure 2^n curve
2s→4s→…→1024s = 34:06 window, jitter removed). The system must behave
**predictably and verifiably**: every wait is a power of 2, the
user sees `00:02 → 00:04 → … → 17:04` and the countdown matches the log.

### 4.2 The critical path never breaks because of optional data
`2b2d17a0`: if the highspeed "draw" fails inside its budget, it
degrades to `draw-miss` and the prompt is sent anyway. Applicative functor
style: a parallel branch with its own budget + graceful degradation, never
aborting the turn because of an adornment.

### 4.3 Budgets per consecutive failures, not accumulated
`c578e14a`: a model request that completes returns the whole recovery
budget. Discrete failures in long tasks no longer add up until they kill the
turn. Recovery is the norm, not the prize.

### 4.4 Absolute time, not duration snapshots
`c578e14a` + `3ab83c67`: events carry `nextAttemptAtMs`/`nextRetryAt`
(epoch). A countdown over `delayMs` resets on every re-render or snapshot
replay; over absolute time it self-calibrates.

### 4.5 The data's last mile is part of the feature
`3ab83c67` (expensive lesson): the v4 producer computed `nextRetryAt` and
`reasonCode`, but `toRetryStatus` discarded them → the pill stayed "old"
for an entire deploy. Rule: **every new datum travels all the way to the
render**, and if the state has two UI surfaces (shared pipeline + v4
projection), both are verified.

### 4.6 The network does not gate local features
`2ac70c51` (Wave 8): the dynamic workflow asked zcode.z.ai whether it was
enabled, fail-closed — the gateway went down and "the plan tools
disappeared". The local override now resolves **before**
any network call (production = alwaysOn); the user's choice
still wins on top. Corollary: server attributes = defaults, never
requirements for what is local.

### 4.7 Tolerate model mistakes, not only provider ones
`2ac70c51`: `Skill("dynamic-workflows:dynamic-workflows")` (plugin:skill
habit) killed a whole plan. The matcher now tries the bare
segment of prefixed requests. It only widens, never relaxes exact matches.

### 4.8 Honest provider error classification
`9bb337bf` + `08d05f36`: the official z.ai code table — gateway 502 ≠
429 rate limit ≠ overload ≠ window limit. The 1308/1310/1316-1321 with a
parseable `next_flush_time` move from terminal to "wait for the reset" (24h
cap, 120s floor); without a reliable time, fail-fast (no waiting blindly). The UI
says what happened ("z.ai server error — retrying 4/10 · 00:52"), not
"Reconnecting".

### 4.9 JSONL sidecars as a bridge between processes
`1e4f7413` (live CoT) + `d4f231bc` (tool-arg streaming): the agent writes
`live-io-<session>.jsonl` next to the rollout; the bot reads it and builds
the boxes live. Same pattern as the logs: **the file is the contract**.
Advantages: zero process coupling, survives restarts, debuggable by hand.

### 4.10 Deploys are verifiable or they are not deploys
`40f0c958`: every wave leaves a *marker* (a minification-proof string
literal) in the bundle; `scripts/verify-deploy.nu` checks the app
bundle + the repo dist + the UI asar + the running process. The documented
mine: when the workspace IS this monorepo, the agent resolves from
`apps/zcode-cli/packages/cli/dist/zcode.cjs` **before** the app bundle —
a swap without a bundle leaves the dist stale and "the deploy did not take".

## 5. Bot ↔ fork connections (which commit enables what in the bot)

| Fork commit | What it gives the bot |
| --- | --- |
| `1e4f7413` live CoT sidecar | `live_io` (F73): partial CoT live during the request |
| `4b46d692` ownership suffix | CoT boxes distinguish source/state |
| `d4f231bc` tool-arg streaming | the box header shows the edit composing (lines growing), not a 150-line dump at the end |
| `942e82f7` verbosity modes | the bot respects/exposes the transcript detail modes |
| `7c33c912` `model:` frontmatter | phone prompts can pin a model per turn |
| `f85a67f6` deterministic curve | the bot's countdown matches reality (exact 2^n) |
| `2ac70c51` workflow alwaysOn | phone plans never lose the tools because of a gateway 502 |
| `d1c0b9f5` Telegram announce | `build-install.nu` itself announces the swap in the chat |

The bot does NOT depend on the fork to exist (it degrades to "no boxes/no
countdown"), but the fork is what makes it **useful**: without sidecars, the
bot only sees the logs' post-mortem.

### 5.1 The daemon-local channel (B3a, ADR-022 — 2026-10-29)

The historical "sidecar files" boundary had a ceiling: an external process
CANNOT write into the real conversation (the agent's stdio is private
to the Host; resuming the session from outside creates a second runtime). B3a
opens the native path: a Host unix socket
([`DAEMON-CHANNEL.md`](./DAEMON-CHANNEL.md)) that exposes inbound via
`handleInboundMessage` (the SAME composer pipeline), the
`bot-channel-continuous` stream and service queries (listTasks/quota/meta/stop).
The Kotlin daemon (B3b, repo `zcode-bot-kotlin`) is the client. In live mode
the channel replaces the live-io sidecar as the source of CoT/tool-args; the
sidecar remains for headless mode and the post-mortem.

## 6. Recorded architecture decisions (and why)

- **Source fork, never a binary patch.** asar-patching silently broke
  Squirrel updates (Oct 2026). Every change is a normal
  commit; updates arrive only through `sync-upstream.nu`.
- **The workspace agent can be the repo dist** (resolution order:
  env → monorepo dist → app bundle). Documented and gated
  by `verify-deploy.nu`; the bundle pipeline regenerates both.
- **Local fail-open / network fail-closed**: we inverted upstream's default
  for local features (Wave 8) but kept fail-closed for
  waiting on the provider without a reliable datum (`next_flush_time` absent ⇒
  do not wait). The difference: who owns the fact.
- **Two UI surfaces for the retry** (`ZCodeApiRetryStatus` pipeline +
  v4 `ApiRetryState` projection). They were not unified: each serves its own
  transport (legacy session vs desktop-continuous). The cost (verifying
  both) was recorded instead of a merging refactor.
- **The bot reads files, not APIs**: same reason as 4.9. The alternative
  (IPC/websockets) couples processes that must survive separately.

## 7. Daily operation (quick reference)

| Task | Command / gesture |
| --- | --- |
| Am I on the new build? | `scripts/verify-deploy.nu` → PASS |
| Deploy a change | implement → tests → commit `[fork]` → push `--no-verify` → `scripts/build-install.nu --yes` (or manual bundle + swap) → ⌘Q → verify |
| Network failure diagnosis | `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`: `model.network.failed` / `model.network.retry_scheduled` (the `delayMs` must be powers of 2) |
| Emergency stack restart | `/nuclear` from Telegram (never kill from the headless bot — it kills its own host) |
| Bot logs | `~/.zcode/hooks/logs/` (958 days of rotation) |
| Bot state | `~/.zcode/hooks/state/`, queue: `bot-queue.json` |
