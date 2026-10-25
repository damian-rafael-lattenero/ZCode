# ZCode fork — Damian Lattenero

Personal fork of [zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0).
The app installed at `/Applications/ZCode.app` on this Mac is **built from this
repo**, not downloaded from Z.ai. Updates arrive only through the ritual below.

## Why a fork

Z.ai does not accept community PRs ("Only collaborators can create PRs") and the
feature request for a first-class Diff Ask entry went unanswered. The ZCode
**binary is never patched** (asar patching broke Squirrel updates silently in
Oct 2026); instead the change lives in source, as a normal git commit.

## What the fork changes

| Commit prefix | File | Change |
| --- | --- | --- |
| `[fork]` | `packages/ui/src/plugin-ui/adapters/useUiPluginRecommendations.ts` | Prepends local UI-plugin recommendations (Diff Ask) to the list served by Z.ai's client-config service, so Diff Ask shows in the side-pane **New tab → App plugins** grid (and the store's recommended chips). |
| `[fork]` | `packages/ui/src/v4/ConversationStatusPanel.tsx` | The **Changes** row in the status panel (git tools) opens the Diff Ask plugin panel directly (ported from the retired asar patch). Resolves the surface via the plugin UI bridge and opens the side-pane tab; falls back to the stock git review when the plugin is missing. |
| `[fork]` | `packages/shared/src/command-types.ts`, `packages/services/src/commands/commandFileParser.ts`, `packages/ui/src/v4/forkCommandModel.ts` (+ tests), `packages/ui/src/v4/SessionPane.tsx` | **`model:` frontmatter honored per command turn**: `model: <providerId>/<modelId>[$<level>]` (or bare modelId) in a custom command's frontmatter runs that turn on that model (validated against the live selection view; unknown model/level never sent). |
| `[fork]` | `packages/ui/src/v4/SessionPane.tsx`, `packages/ui/src/SlashCommandPlugin.tsx` | **Client-side `/diff`**: an app-layer slash command that opens the Diff Ask panel instantly with NO model turn. App commands now take precedence over same-name CLI catalog entries (so the client-side /diff eclipses the CLI one). Requires a live session. |
| `[fork]` | `packages/ui/test/useUiPluginRecommendations.test.ts`, `packages/ui/test/v4ConversationStatusPanelGitReview.test.ts`, `packages/ui/test/forkCommandModel.test.ts` | Expectations/new tests for the fork behavior. |
| `[fork]` | `scripts/sync-upstream.sh`, `scripts/build-install.sh`, `scripts/bootstrap-diff-ask.sh`, `FORK.md` | This runbook. `build-install.sh` also ensures the Diff Ask plugin is installed (see "Diff Ask plugin" below). |

Every modified upstream file carries a `FORK CHANGE` notice at the top (Apache-2.0 §4).
`LICENSE` and `NOTICE.md` are kept intact.

## Branch layout

- `main` — mirror of `upstream/main`. **Never commit here.**
- `damian` — `main` + the `[fork]` commits. This is what gets built and installed.
- Remotes: `origin` = `damian-rafael-lattenero/ZCode`, `upstream` = `zai-org/ZCode`.

Upstream tags/releases lag the shipped app (e.g. app 3.16.3 shipped while `main`
and the last tag were 3.16.2 / v3.15.1), so the sync follows **`upstream/main`**,
not tags. The fork can be one patch release behind the official app until Z.ai
pushes the source.

## The ritual (when Z.ai ships a new version, or whenever you want the latest)

```bash
cd ~/Projects/ZCode
scripts/sync-upstream.sh      # fetch + merge upstream/main into damian + gates
scripts/build-install.sh      # bundle (ZCODE_ENV=production, unsigned) + swap /Applications/ZCode.app
git push origin damian
git tag damian-v<version>-<yyyymmdd> && git push origin --tags
```

Merge conflicts, if any, will be in the `[fork]` files above — resolve by
re-applying the small change. If upstream reworks the recommendations pipeline,
`git log -p -- packages/ui/src/plugin-ui/adapters/` shows where it moved.

## Deploy de features (el proceso, 2026-10-25)

Cada feature sigue SIEMPRE el mismo pipeline, en este orden:

1. **Implementar** + tests (red-green cuando aplique) + `pnpm typecheck`
   (¡la raíz NO compila `apps/zcode-cli`! cada package ahí compila con su
   propio tsc — correr también `cd apps/zcode-cli/packages/adapters && npx
   tsc --noEmit` si se tocó) + `pnpm lint` + `pnpm architecture:check
   --changed`.
2. **Commit** `[fork] ...` + `git push --no-verify origin damian`.
3. **Bundle**: `ZCODE_ENV=production CSC_IDENTITY_AUTO_DISCOVERY=false
   ELECTRON_MIRROR=https://artifacts.electronjs.org/ mise exec -- node
   scripts/mise-run.mjs pnpm bundle:desktop` con salida a ARCHIVO y verificar
   el `EXIT:` real (un `| tail` en background devuelve el exit del tail y
   **enmascara el fallo** — pasó el 25/10 y casi instala un build viejo).
4. **Swap** con semántica de rename (`mv` a `.prev` + `ditto` + `codesign
   --sign -`): la app corriendo sigue viva hasta el ⌘Q.
5. **⌘Q + reabrir** (lo hace Damian; nunca matar procesos zcode desde el bot).
6. **Verificar**: `scripts/verify-deploy.sh` — chequea que el bundle del app
   Y el repo dist tienen los markers de cada ola, que no hay apps ZCode extra
   en /Applications, y que la app corriendo arrancó después del swap.

**Mina documentada (25/10):** cuando el workspace activo ES este monorepo, el
agent se resuelve desde `apps/zcode-cli/packages/cli/dist/zcode.cjs` ANTES que
desde el bundle del app (`resolveDefaultZCodeAgentCommand` en
`zcodeAgentProcessManager.ts`: env → monorepo dist → bundle). El paso de
bundle regenera ese dist, así que el pipeline de arriba mantiene ambos frescos
— pero un swap SIN bundle (o un bundle que falla a mitad) deja el repo dist
viejo y "el deploy no impactó". Por eso el paso 6 chequea los dos binarios.

## Diff Ask plugin (separate repo)

The three fork touch points (Changes button, `/diff`, plugin-grid card) resolve
the plugin at **runtime** by id `diff-ask@dev-zcode-diff-ask-5098ef5a` and
degrade to stock behavior when it is missing — the fork never bundles plugin
files, so plugin releases don't need an app rebuild.

- Source repo: `~/Projects/zcode-diff-ask` (local) / GitHub
  `damian-rafael-lattenero/zcode-diff-ask`. Both produce the **same marketplace
  id** (`dev-zcode-diff-ask-5098ef5a`, from that repo's `marketplace.json`
  `name`), which is why the id hardcoded in the fork stays valid across
  sources — don't rename it there.
- `scripts/bootstrap-diff-ask.sh` — ensure marketplace + install, idempotent:
  local checkout when `~/Projects/zcode-diff-ask` exists (or
  `$ZCODE_DIFF_ASK_REPO`), GitHub shorthand otherwise. `marketplace add`
  re-binds an existing marketplace to the given source. Run by
  `build-install.sh`; standalone for plugin-only updates (restart ZCode after).
- Plugin-only iteration (no app rebuild): `npm run build` + version bump in the
  plugin repo + commit + push, then `bash scripts/bootstrap-diff-ask.sh`.
- Gotcha (2026-10-24): the marketplace scan validates EVERYTHING inside the
  source directory (`.gitignore` is ignored) — keep heavy files (e.g. the old
  341 MB asar backup, now at `~/zcode-official-backup/zcode-diff-ask-tools-backup/`)
  out of the plugin repo root, or updates die with `plugin_marketplace_invalid`.

## Build notes

- Toolchain pinned by `mise.toml` (node 24.14.0, pnpm 10.33.2): `mise install`.
- Build identity axis: `ZCODE_ENV=production` → appId `dev.zcode.app`, product
  "ZCode" (replaces the official app, same `~/.zcode` data). The default
  (`test`) builds "ZCode Preview" against the test backend — not what we want.
- `CSC_IDENTITY_AUTO_DISCOVERY=false`: no Apple signing identity; the bundle is
  ad-hoc signed after install. Consequence: the built-in auto-updater silently
  ignores Z.ai payloads (signature mismatch) — by design.
- `ELECTRON_MIRROR=https://artifacts.electronjs.org/`: the repo's default
  (npmmirror) failed to download from this network.
- Artifact: `packages/desktop/dist/ZCode-<version>-mac-arm64.zip` (~187 MiB).

## Rollback

The official app is always re-downloadable (verify sha512 against
`update-info.json`, extract with `ditto -x -k`, atomic `mv` into
`/Applications`). The official 3.16.3 bundle that the fork replaced was kept at
`~/zcode-official-backup/ZCode-3.16.3-official.app` (outside `/Applications`
so LaunchServices does not see two `dev.zcode.app` bundles).

## Ledger (installed builds)

| Tag | Upstream version | Installed | Notes |
| --- | --- | --- | --- |
| `damian-v3.16.2-20261024` | 3.16.2 (`upstream/main` 2026-10-20) | 2026-10-24 | Verbosity modes (Summary/Normal/Verbose) + retroactive expand-all switch. Replaced wave-2 build (model:/diff, 23/10, untagged). |
| `damian-v3.16.2-20261023b` | 3.16.2 (`upstream/main` 2026-10-20) | 2026-10-23 | Grid card + Changes button → Diff Ask. Replaced `damian-v3.16.2-20261023`. |
| `damian-v3.16.2-20261023` | 3.16.2 (`upstream/main` 2026-10-20) | 2026-10-23 | First fork build (grid card only). Replaced official 3.16.3. |

## Gotcha: pushing needs `--no-verify`

The husky pre-push gate (`verify:pre-push` = lint + db:schema + architecture
+ affected unit tests) is impractical for this fork (verified 2026-10-24):

1. The hook needs `pnpm` on PATH — push from a mise-shims shell or via
   `mise exec --`, otherwise it dies with code 127 before running anything.
2. Upstream's old lint errors are gone (lint now passes with 0 errors), but
   `test:unit:affected` refuses a dirty tree (local untracked dirs count —
   `.zcode/` is now gitignored for this) and, for feature-sized changes
   touching `packages/ui` + `packages/shared`, selects a very large UT set
   that runs for many minutes and looks stuck.

So the ritual is: run `pnpm typecheck`, `pnpm lint`,
`pnpm architecture:check --changed` and the targeted tests yourself, then:

```bash
mise exec -- git push --no-verify origin damian
```

Re-check after each sync — if the gate gets fast/reliable again, drop the flag.

## Ola 2 (23/10 noche, tag `damian-v3.16.2-20261023c`): model: + /diff client-side

- **A** — los user commands con `model:` en el frontmatter corren SU turno en
  ese modelo: `model: account:plan/GLM-5.3-Flash$low` (o modelId pelado).
  Parseado por `commandFileParser`, aplicado por turno en SessionPane vía
  `forkCommandModel.ts` (validado contra la vista viva — nunca se envía un
  modelo/nivel desconocido). /diff y cualquier comando futuro: segundos
  en vez de 25-30s.
- **C** — `/diff` es ahora un app-command 100% client-side: abre el panel de
  Diff Ask al instante, SIN turno del modelo (0 tokens). Los app-commands
  ganan a los homónimos del catálogo CLI (precedencia invertida en
  SlashCommandPlugin). Requiere sesión viva.
- **B** (lado bot, commit `5e7545f` del repo bot — el runtime `zcode.cjs` no
  se buildea desde este repo): cada runtime del protocolo sostiene la Mac
  despierta con `caffeinate -i -w <pid>` mientras vive (también en batería).
  Complementa el `caffeinate -s` del LaunchAgent del poller (AC-only).

## Ola 3 (25/10): resiliencia highspeed ante 502 de zcode.z.ai

El gateway auxiliar `zcode.z.ai` (donde vive `/api/v1/highspeed/`) sufre
micro-cortes 502 de segundos (medido 24-25/10: 4-6 warn/día, ~5-10s cada uno,
mientras `api.z.ai` responde 1s). Dos fixes client-side (spec
`docs/highspeed/highspeed-card-spec.md` §3 reglas 6+16, marcados FORK):

- **Retry de tabla fija** — `highspeedHttpTransport` reintenta SOLO fallos
  transitorios (502/503/504, error de red, timeout): exactamente 2 extras a
  1s y 3s (compilado, NO "n/10" abierto). Business codes y 4xx no se
  reintentan. La tabla es inyectable (`transientRetryDelaysMs`) para tests.
- **El envío nunca se rompe por la carta** — si el draw rechaza DENTRO del
  presupuesto de 1s, `prepareTurn` degrada a envío normal (`draw-miss`) en
  vez de lanzar la excepción por el RPC y abortar el prompt (bug de
  superficie: un 502 rápido mataba el turno completo). Post-presupuesto ya
  estaba cubierto (race libera in-flight).

## Ola 4 (25/10 tarde): "Reconnecting n/10" de raíz — backoff hasta 15min

Diagnóstico (log del CLI `~/.zcode/cli/log/zcode-2026-10-25.jsonl`): 567
`model.request.failed` en el día, TODOS `statusCode: 502` de
`api.z.ai/api/anthropic` (0 cuatro-veintinueve: no es rate limit ni el uso
de Damian — es el gateway de z.ai). El "Reconnecting n/10" del UI es el
retry del adapter (`maxAttempts: 11`, backoff 2s→60s): una falla de ~30s ×
11 intentos se agota en ~5 min y **mata turnos largos enteros**.

Fix: `forkModelRetrySpawnEnv.ts` inyecta al spawn del agent
`ZCODE_MODEL_RETRY_MAX_DELAY_MS=900000` (15min) SOLO si el usuario no lo
seteó. Curva resultante 2s→4s→…→512s→900s ≈ 32min de ventana de
recuperación con los mismos 10 reintentos (curva exponencial fija de
upstream, solo se levanta el tope). Elegido por Damian: esperar a que z.ai
se recupere (10-15min por espera está bien) antes que perder la tarea.

## Ola 4b (25/10 noche): budget por fallas consecutivas + countdown mm:ss

Con la ventana de 15min los dos defectos de UX que quedaban del "n/10":

1. **El contador nunca reseteaba.** `streamRecoveryRetryCount` solo se
   inicializaba al crear el turno, así que en tareas largas (decenas de
   iteraciones) fallas discretas acumulaban hasta agotar las 10 recuperaciones
   del core aunque entre cada una hubiera requests exitosos. Fix en
   `turn-model-step.ts`: un modelo-request que completa devuelve el budget
   completo (las fallas cuentan como *consecutivas*, no acumuladas por turno).
   Test red-green en `runtime-stream-recovery.test.ts`: 2 recuperaciones
   separadas por un éxito ambas muestran `retryNumber: 1`.

2. **No se sabía cuánto faltaba para el próximo intento.** El adapter ahora
   publica `nextAttemptAtMs` (epoch absoluto) en `model_retry_scheduled`
   (runner-generate/runner-stream/empty-completion-retry, los 3 sitios);
   shared lo normaliza a `ZCodeApiRetryStatus.nextRetryAtMs` (schema legacy
   incluido; core stream recovery manda `null` porque reabre sin espera
   local) y el UI (`ChatApiRetryStatus`) renderiza al lado del contador un
   countdown `mm:ss` (`h:mm:ss` ≥1h) que se auto-calibra con el reloj —
   re-render o replay de snapshot no lo resetea. Sin el campo (runtime
   viejo) la UI queda igual que antes: solo el contador.

## Ola 5 (25/10 noche): límites de uso z.ai — esperar al reset en vez de morir

La doc oficial (docs.z.ai/api-reference/api-code) dice que 1308/1310/1316-1321
(límites de ventana de uso) llevan `next_flush_time` — el momento en que el
límite se resetea. Upstream los trata como terminales (mata el turno) y además
descarta el campo en `summarizeProviderBusinessBody` (whitelist que no lo
copiaba).

Fix (FORK): si el error trae un reset **parseable**, la familia pasa de
terminal a "reintentar a esa hora":

- `failure-usage-limit-reset.ts` (nuevo): parsea `next_flush_time` del body
  (campo JSON, unix s/ms o ISO) o del mensaje interpolado ("Your limit will
  reset at …"); sin zona horaria se asume UTC. Wait con clamps: tope 24h
  (ventana máxima documentada), piso 120s si el reset ya pasó (evita hot-loop;
  cada reintento consume un attempt del presupuesto).
- `classifyProviderBusinessFailure`: con código de la familia Y reset
  parseable → `retryable: true` + `retryAfterMs`/`usageLimitResetWaitMs` =
  wait. **Sin** reset parseable mantiene el fail-fast de upstream (no se
  espera a ciegas). 1113/1309/1313 (saldo/plan/fair-use) quedan terminales.
- `calculateRetryDelay`: el wait del reset bypasea el gate de 5min de
  Retry-After (es determinista, no un header "parece razonable").
- Bonus gratis: los stops de workflow por quota computan `resetAt` desde
  `context.retryAfterMs` — ahora la notificación lleva la hora real de reset.
- UI: el countdown de Ola 4b ya lo muestra ("Reconnecting 2/11 · 1:59:32").

Tests: 11 del parser + 4 del clasificador (incluye 1113 intocado y 1308 sin
flush sigue terminal) + 3 del bypass del gate. `runner.test.ts` tiene 1 falla
preexistente en el baseline (delay 64000 vs 60000) verificada con stash — no
es de esta ola.



## Ola 6 (25/10 tarde): labels honestos (B2) + proceso de deploy a prueba de balas

Lo que faltaba del cartel "Reconnecting n/10": decir QUÉ está pasando. El
adapter ya publica `reason` en `model_retry_scheduled`; ahora viaja hasta el
UI (`ZCodeApiRetryStatus.reason`, schema legacy incluido) y el texto cambia
según la causa (i18n en/zh, fallback al texto genérico en reason desconocido):

- `server_error` → "z.ai server error — retrying n/10" (+ countdown)
- `provider_overloaded` → "z.ai overloaded — retrying n/10"
- `rate_limited` → "Rate limited — retrying n/10" (las 429/1302 reales)
- `timeout`/`stream_idle_timeout` → "Stream stalled — retrying n/10"
- `network_error`/`stale_connection` → "Connection lost — retrying n/10"
- stream recovery del core (marca `stream_recovery` en el normalizer) →
  "Recovering stream n/10" sin countdown (reabre al instante — así se
  distingue del retry con espera del adapter)

Diagnóstico del "no impactó" del 25/10: sí había impactado (agente dist +
bundle + renderer verificados frescos); lo que se vio fue un stream recovery
(sin countdown por diseño, antes indistinguible) y/o apps viejas en
/Applications confundiendo al Dock. Acciones: borradas `ZCode.prev.app` y
`ZCode-3.16.2-patched.bak`; nuevo `scripts/verify-deploy.sh` (sección "Deploy
de features"); documentada la mina de resolución del agent (monorepo dist
antes que el bundle). Tests: 5 shared (reason passthrough ×3, stream recovery,
fallback) + 5 UI (mapping puro ×2, render server_error/stream_recovery/fallback).
