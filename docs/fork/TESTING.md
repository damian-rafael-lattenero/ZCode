# Testing del fork: qué existe, cuánto tarda, y dónde están las grietas

> Duraciones **medidas** en esta Mac (M-series, 8 threads de lint, vitest
> 4.1.x) durante las olas de octubre 2026. El tiempo dominante de los tests
> unitarios chicos casi siempre es `import`/`transform`, no la ejecución.

## 1. Suites que toca el fork (con duración medida real)

| Suite (comando desde la raíz o el workspace) | Tests | Duración medida | Qué cubre |
| --- | --- | --- | --- |
| `packages/ui/test/chatApiRetryCountdown.test.ts` + `packages/shared/test/zcodeApiRetryStatus.test.ts` | 18 | ~3–5 s (jsdom) | countdown mm:ss, labels por reason, `toRetryStatus` última milla, normalizer |
| `apps/…/core/tests/runtime-stream-recovery.test.ts` | 3 | ~6 s (import 5.8 s) | budget de recovery por fallas consecutivas (red-green) |
| `apps/…/adapters/tests/failure-usage-limit-reset.test.ts` + `failure-classifier.test.ts` + `runner-retry.test.ts` | 109 | ~1.9 s | parser `next_flush_time`, tabla de códigos z.ai, bypass del gate 5 min |
| `apps/…/adapters/tests/runner.test.ts` | 129 | ~2.6 s | curva 2^n con jitter=0 (random adverso), env parsing |
| `apps/…/adapters/tests/skills.test.ts` | 19 | ~1.1 s | matcher de nombres `prefijo:nombre` → segmento desnudo |
| `apps/…/bootstrap/tests/*projection*.test.ts` | 5 | ~5.5 s | proyección v4 (ApiRetryState con reason) |
| `packages/services/test/forkModelRetrySpawnEnv.test.ts` | 3 | <1 s | inyección de env solo si el usuario no lo seteó |
| `packages/desktop/test/desktopRuntimeEnv.test.ts` | 36 | ~0.25 s | env del Host por build tier (production = alwaysOn) |
| **Suite completa de adapters** (`npx vitest run packages/adapters/tests/` desde `apps/zcode-cli`) | 2 289 | **~59 s** | todo el modelo/retry/classifier — correrla antes de tocar adapters |

Referencia de suites grandes: `pnpm test:unit` / `pnpm test` (workspace
entero) solo a pedido explícito; `verify:pre-push` selecciona UT afectadas
pero rechaza árbol sucio y puede tardar muchos minutos (ver
[`FORK.md §Gotcha`](../../FORK.md)).

## 2. Verificación por cambio (pipeline obligatorio)

```
pnpm typecheck                      # raíz: packages/* (NO apps/zcode-cli — grieta §3)
cd apps/zcode-cli/packages/<pkg> && npx tsc --noEmit   # SIEMPRE que se tocó apps/
npx vitest run <tests afectados>    # red-green cuando aplique
pnpm lint                           # oxlint, ~0.6 s en 6 700 archivos
pnpm architecture:check --changed   # <2 s; archivos nuevos ⇒ excepción en architecture-policy.yaml
```

El **bot no tiene suite formal** (el pytest del venv es infra sin uso). Su
"testing" es: hot-backup por cambio (`~/.zcode/hooks/backups/`), watchdogs en
producción (`healer` lee heartbeats y actúa si nadie entrega — F79c), y
verificación en vivo desde Telegram. Los tests del lado fork son los que
cubren los contratos que el bot consume (sidecars, curvas, estados).

## 3. Grietas conocidas (lo que el pipeline NO atrapa solo)

1. **El typecheck de la raíz no compila `apps/zcode-cli`.** Cada package ahí
   compila con su propio `tsc`. El 25/10 un contrato CLI faltante rompió el
   bundle en pleno deploy (commit `17fc5959` lo tapó). Regla: si tocaste
   `apps/zcode-cli/**`, correr el `tsc --noEmit` de ese package (o el build
   del agente) ANTES de `bundle:desktop`.
2. **`oxfmt` no cubre `apps/`** y `packages/ui/src/chat-input-toolbar/display.tsx`
   NO es fmt-clean preexistente — correrlo ahí masacra el diff (~140 líneas
   de ruido). Edits a mano respetando el estilo del archivo.
   `pnpm fmt:check` falla repo-wide en ~2 136 archivos: preexistente.
3. **`runner.test.ts` tiene 1 falla de baseline** (delay 64000 vs 60000,
   verificada con stash el 25/10). No atribuirla a cambios nuevos.
4. **Lint: 96–97 warnings preexistentes** (0 errores). Ninguno en archivos
   del fork al 28/10.
5. **Un `| tail` en background devuelve el exit del tail** y enmascara
   fallos de build (pasó el 25/10). Los builds van con `> log 2>&1; echo
   "EXIT:$?" >> log` y se verifica el `EXIT:` real.

## 4. El deploy también se testea (`scripts/verify-deploy.sh`)

Gate post-swap, corre en <2 s:

- **Markers por ola** en los TRES binarios: `Resources/glm/zcode.cjs`
  (agente), `app.asar` (UI/shared — strings literales a prueba de
  minificación, `grep -a` binario), y el dist del repo (porque el agente de
  este workspace resuelve desde ahí ANTES que desde el bundle).
- Sin apps ZCode extra en `/Applications` (por bundle id — el Dock/Spotlight
  abre la vieja si existe).
- La app corriendo arrancó después del swap (detección por `ps comm` — el
  main de Electron lanza con argv[0] sin path y `pgrep -f` no lo ve).

Cada ola nueva agrega su marker a la lista del script. El `EXIT` del bundle
y el PASS del verify son las dos firmas de un deploy completo.

## 5. Duraciones del pipeline completo de deploy (medidas)

| Paso | Duración típica |
| --- | --- |
| `pnpm typecheck` (incremental) | 10–30 s (frío: minutos) |
| `tsc --noEmit` de un package de `apps/` | 30–45 s |
| `pnpm lint` | ~0.6 s |
| `pnpm architecture:check --changed` | <2 s |
| Tests afectados (los de §1) | 2–60 s según alcance |
| `bundle:desktop` completo | **5–6 min** (prepare:runtime-assets ~2–3 min; electron-builder ~2–3 min; DMG después del .app — el .app ya sirve) |
| Swap + codesign + verify | ~15 s |

Flujo reactivo: el bundle corre en background y notifica solo al terminar
(sin sleep-polling); el swap se hace al recibir la notificación y el ⌘Q lo
hace Damian (el bot headless nunca mata procesos de ZCode — mataría su
propio host, incidentes reales del 13/10).
