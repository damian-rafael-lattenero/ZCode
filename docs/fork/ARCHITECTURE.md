# Arquitectura del sistema: fork de ZCode + bot de Telegram

> Este documento es el mapa maestro. El runbook operativo vive en
> [`FORK.md`](../../FORK.md) (raíz del repo) y la estrategia de testing en
> [`TESTING.md`](./TESTING.md). Todo lo acá descrito es el estado real al
> 2026-10-28, verificado contra código y logs — no aspiracional.

## 1. Qué es este sistema (en 60 segundos)

Dos piezas que cooperan en la Mac de Damian:

1. **El fork de ZCode** (este repo, rama `damian` = `main` upstream + 26+
   commits `[fork]`): la app de escritorio que usa Damian, construida desde
   fuente e instalada en `/Applications/ZCode.app`. Sobrevive a los 502 del
   gateway de z.ai, muestra estados honestos de reintento con cuenta
   regresiva, y expone telemetría viva que el bot consume.
2. **El bot de Telegram** (`~/.zcode/hooks/zcode_bot/`, paquete Python
   ~15k líneas): control remoto del teléfono. Notifica todo lo que pasa en
   ZCode (turnos, permisos, preguntas, fallos), deja responder permisos
   desde el celular, corre sus propios turnos **headless**, y muestra el
   trabajo en vivo (CoT, subagentes en cajitas, streaming de tool-args).

La frontera entre ambas: **archivos sidecar JSONL y logs** en `~/.zcode/`.
El fork escribe hechos; el bot los lee. No hay API interna — cualquier
proceso puede leer un archivo, y un archivo sobrevive a ambos.

## 2. Mapa de componentes

```
┌───────────────────────── /Applications/ZCode.app (build del fork) ─────────────────────────┐
│                                                                                             │
│  Main (Electron)                                                                            │
│   ├─ desktopRuntimeEnv.ts ── env del Host: JITTER=0, MAX_DELAY=1024000 (Ola 4/7),           │
│   │                          DYNAMIC_WORKFLOW_MODE=alwaysOn en producción (Ola 8)           │
│   └─ swap con semántica de rename (mv .prev + ditto + codesign)                             │
│                                                                                             │
│  Host (utility process) — packages/services                                                 │
│   ├─ zcodeAgentService ──── spawn del agente + policy sync (dynamic workflow, off-peak)     │
│   ├─ forkModelRetrySpawnEnv ── inyecta defaults de retry SOLO si el usuario no los seteó    │
│   └─ codingPlanSubscription ── client/configs de zcode.z.ai (fail-closed ⇐ Ola 8 lo anula)  │
│                                                                                             │
│  Renderer (app.asar) — packages/ui                                                          │
│   ├─ pill del chat: toRetryStatus → ChatApiRetryStatus (labels por reason + countdown)      │
│   └─ dos superficies para el mismo estado (lección Ola 6b: verificar siempre ambas)         │
└──────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                           │ spawn (env fork) + stdio protocol
                                           ▼
┌───────────────────────── Agente CLI (Resources/glm/zcode.cjs) ─────────────────────────────┐
│  adapters ── retry-policy (curva 2^n pura), failure-classifier (códigos z.ai +              │
│              next_flush_time), runner-retry (calculateRetryDelay), request-admission        │
│  core ────── turn loop, stream recovery (budget por fallas CONSECUTIVAS), model-status      │
│  bootstrap ── product-projection v4 (ApiRetryState: nextRetryAt + reason crudo)             │
│                                                                                             │
│  Escribe: ~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl  (diagnóstico post-mortem)                │
│  Escribe: <workspace>/.zcode/live-io-<session>.jsonl  (sidecar EN VIVO: CoT + tool-args)    │
└──────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                           │ api.z.ai (SSE; 502 en olas) / zcode.z.ai (configs)
                                           ▼
                                    (red — lo único que no controlamos)

┌───────────────────────── Bot: ~/.zcode/hooks/zcode_bot/ ───────────────────────────────────┐
│  LaunchAgents (3): telegram-watch (eventos de la app), telegram-cmds (loop de comandos),    │
│                     bot-healer (watchdog del canal)                                         │
│                                                                                             │
│  gateway.py (fachada de 18 líneas — el paquete es la implementación)                        │
│   ├─ poller ─────── driver async del loop: long-poll 3s, at-least-once (F2d)                │
│   ├─ dispatcher ─── ÚNICO procesador de updates: serial + dedup por update_id (ADR-001)     │
│   ├─ commands/ ──── handlers de Telegram (/task, /stop, /nuclear, menús…)                   │
│   ├─ workers ────── turnos headless: bot-queue.json → prompt_worker como PROCESO aparte     │
│   │                 (F16: aislamiento real — /nuclear mata el turno, no al bot)             │
│   ├─ live_io ────── lee los sidecars live-io-<sid>.jsonl del fork (F73)                     │
│   ├─ agent_live ─── cajitas "Progress agent N.M": el trabajo interno de cada subagente      │
│   │                 (F63; se alimenta de los sidecars que el fork commitea)                 │
│   ├─ spectator ──── los turnos de la Mac en vivo en Telegram (F33)                          │
│   ├─ attach ─────── /task se engancha al turno YA corriendo (F62)                           │
│   ├─ nuclear ────── ☢️ restart anunciado y verificado del stack (F4e)                       │
│   ├─ healer ─────── watchdog de CONTRATO: si un turno corre y nadie entrega, actúa (F79c)   │
│   └─ circuit_breaker / rate_limiter / concurrency ── defensas del canal                     │
│                                                                                             │
│  Estado: ~/.zcode/hooks/state/ · Backups por hot-fix: ~/.zcode/hooks/backups/               │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Por qué el bot es headless

- **Aislamiento real de proceso.** Cada turno del teléfono lo corre
  `prompt_worker` como **subproceso separado** (F16), no dentro del bot ni
  de la app. `/nuclear` o un crash matan ese turno; el loop de comandos y la
  app de la Mac siguen vivos. La cola (`bot-queue.json`) sobrevive a todo.
- **No depende de la UI.** Los turnos usan el runtime CLI del agente
  (el mismo `zcode.cjs` del bundle) con sesión persistida en `~/.zcode/` —
  el teléfono "es" otro cliente de la misma sesión, no un control remoto de
  pantallas. Los permisos tienen su flujo headless propio.
- **El bot puede monitorear y operar la app sin estar adentro de ella.**
  Los eventos llegan por hooks de ZCode (`watch-app`), los estados por los
  sidecars/logs. Por eso el bot sigue funcionando cuando la app se cuelga,
  se actualiza o está en ⌘Q.

## 4. Patrones de diseño del fork (con el commit que los introduce)

Estos son los principios que se repiten en los 26 commits. Son las reglas a
seguir para cambios futuros (también en [`FORK.md §Deploy`](../../FORK.md)).

### 4.1 Tablas fijas y curvas deterministas — nunca "n/10" abierto
`2b2d17a0` (highspeed: `[1s, 3s]` fija), `f85a67f6` (curva 2^n pura
2s→4s→…→1024s = ventana 34:06, jitter eliminado). El sistema debe comportarse
de forma **predecible y verificable**: cada espera es una potencia de 2, el
usuario ve `00:02 → 00:04 → … → 17:04` y el countdown coincide con el log.

### 4.2 El camino crítico nunca se rompe por datos opcionales
`2b2d17a0`: si el "draw" de la highspeed falla dentro de su presupuesto, se
degrada a `draw-miss` y el prompt se envía igual. Estilo applicative functor:
paralelo con presupuesto propio + degradación graceful, nunca abortar el
turno por un adorno.

### 4.3 Presupuestos por fallas consecutivas, no acumuladas
`c578e14a`: un request de modelo que completa devuelve todo el presupuesto de
recovery. Las fallas discretas en tareas largas ya no suman hasta matar el
turno. La recuperación es la norma, no el premio.

### 4.4 Tiempo absoluto, no snapshots de duración
`c578e14a` + `3ab83c67`: los eventos llevan `nextAttemptAtMs`/`nextRetryAt`
(epoch). Un countdown sobre `delayMs` se resetea con cada re-render o replay
de snapshot; sobre tiempo absoluto se auto-calibra.

### 4.5 La última milla del dato es parte del feature
`3ab83c67` (lección cara): el productor v4 calculaba `nextRetryAt` y
`reasonCode`, pero `toRetryStatus` los descartaba → el pill quedó "antiguo"
un deploy entero. Regla: **todo dato nuevo viaja hasta el render**, y si el
estado tiene dos superficies UI (pipeline shared + proyección v4), se
verifican las dos.

### 4.6 La red no gatea funciones locales
`2ac70c51` (Ola 8): el dynamic workflow consultaba su habilitación a
zcode.z.ai con fail-closed — el gateway caía y "desaparecían las
herramientas de los planes". El override local ahora se resuelve **antes**
de cualquier llamada de red (production = alwaysOn); la elección del usuario
sigue mandando encima. Corolario: atributos del server = defaults, nunca
requisitos para lo local.

### 4.7 Tolerar los errores del modelo, no solo los del proveedor
`2ac70c51`: `Skill("dynamic-workflows:dynamic-workflows")` (hábito
plugin:skill) mataba un plan entero. El matcher ahora prueba el segmento
desnudo de requests con prefijo. Solo amplía, nunca relaja matcheos exactos.

### 4.8 Clasificación honesta de errores del proveedor
`9bb337bf` + `08d05f36`: tabla de códigos oficiales z.ai — 502 gateway ≠
429 rate limit ≠ overload ≠ límite de ventana. Los 1308/1310/1316-1321 con
`next_flush_time` parseable pasan de terminales a "esperar al reset" (tope
24h, piso 120s); sin hora cierta, fail-fast (no se espera a ciegas). El UI
dice qué pasó ("z.ai server error — retrying 4/10 · 00:52"), no "Reconnecting".

### 4.9 Sidecars JSONL como puente entre procesos
`1e4f7413` (live CoT) + `d4f231bc` (tool-arg streaming): el agente escribe
`live-io-<session>.jsonl` junto al rollout; el bot lo lee y arma las cajitas
en vivo. Mismo patrón que los logs: **el archivo es el contrato**. Ventajas:
cero acoplamiento de proceso, sobrevive reinicios, debuggable a mano.

### 4.10 Deploys verificables o no son deploys
`40f0c958`: cada ola deja un *marker* (string literal a prueba de
minificación) en el bundle; `scripts/verify-deploy.sh` chequea bundle del
app + dist del repo + asar del UI + proceso corriendo. La mina documentada:
cuando el workspace ES este monorepo, el agente resuelve desde
`apps/zcode-cli/packages/cli/dist/zcode.cjs` **antes** que desde el bundle
del app — un swap sin bundle deja el dist viejo y "el deploy no impactó".

## 5. Conexiones bot ↔ fork (qué commit habilita qué en el bot)

| Commit del fork | Qué le da al bot |
| --- | --- |
| `1e4f7413` live CoT sidecar | `live_io` (F73): CoT parcial en vivo durante el request |
| `4b46d692` sufijo de propiedad | las cajitas de CoT distinguen fuente/estado |
| `d4f231bc` tool-arg streaming | el header de las cajitas muestra la edición componiéndose (líneas creciendo), no un dump de 150 líneas al final |
| `942e82f7` verbosity modes | el bot respeta/expone los modos de detalle del transcript |
| `7c33c912` `model:` frontmatter | los prompts del teléfono pueden fijar modelo por turno |
| `f85a67f6` curva determinista | el countdown del bot coincide con la realidad (2^n exactos) |
| `2ac70c51` workflow alwaysOn | los planes del teléfono nunca pierden las herramientas por un 502 del gateway |
| `d1c0b9f5` announce de Telegram | el propio `build-install.sh` anuncia el swap en el chat |

El bot NO depende del fork para existir (degrada a "sin cajitas/sin
countdown"), pero el fork es lo que lo hace **útil**: sin sidecars, el bot
solo ve el post-mortem de los logs.

## 6. Decisiones de arquitectura registradas (y por qué)

- **Fork de fuente, nunca patch del binario.** El asar-patching rompió
  silenciosamente las updates de Squirrel (oct 2026). Todo cambio es un
  commit normal; las updates llegan solo por `sync-upstream.sh`.
- **El agente del workspace puede ser el dist del repo** (orden de
  resolución: env → monorepo dist → bundle del app). Documentado y gateado
  por `verify-deploy.sh`; el pipeline de bundle regenera ambos.
- **Fail-open local / fail-closed de red**: invertimos el default de
  upstream para funciones locales (Ola 8) pero mantuvimos fail-closed para
  esperar al proveedor sin dato cierto (`next_flush_time` ausente ⇒ no
  esperar). La diferencia: quién es el dueño del hecho.
- **Dos superficies UI para el retry** (pipeline `ZCodeApiRetryStatus` +
  proyección v4 `ApiRetryState`). No se unificaron: cada una sirve a su
  transport (legacy session vs desktop-continuous). El costo (verificar
  ambas) quedó registrado en vez de una refactor mergatoria.
- **El bot lee archivos, no APIs**: misma razón que 4.9. La alternativa
  (IPC/websockets) acopla procesos que deben sobrevivir por separado.

## 7. Operación cotidiana (referencia rápida)

| Tarea | Comando / gesto |
| --- | --- |
| ¿Estoy en el build nuevo? | `scripts/verify-deploy.sh` → PASS |
| Deploy de un cambio | implementar → tests → commit `[fork]` → push `--no-verify` → `scripts/build-install.sh --yes` (o bundle manual + swap) → ⌘Q → verify |
| Diagnóstico de fallos de red | `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`: `model.network.failed` / `model.network.retry_scheduled` (los `delayMs` deben ser potencias de 2) |
| Emergency restart del stack | `/nuclear` desde Telegram (nunca kill desde el bot headless — mata su propio host) |
| Logs del bot | `~/.zcode/hooks/logs/` (958 días de rotación) |
| Estado del bot | `~/.zcode/hooks/state/`, cola: `bot-queue.json` |
