# B3a: canal «daemon local» — ADR y spec del protocolo

Fecha: 2026-10-29 · Estado: implementado (rama `damian`) · Padre:
[ADR-022](https://github.com/) (`~/Projects/bot/docs/adr/022-live-mode-fork-channel.md`)

> Este documento es **el contrato** para el cliente Kotlin del daemon (B3b).
> Los shapes normativos en TypeScript viven en
> `packages/shared/src/daemon-channel.ts` (exportado por `@zcode/shared`); si
> este texto y ese archivo discrepan, **gana el archivo** — y este texto se
> corrige. El protocolo es aditivo: campos nuevos son opcionales y los lectores
> viejos los ignoran. Romper compat exige bump de
> `DAEMON_CHANNEL_PROTOCOL_VERSION`.

## 1. Contexto y decisión

ADR-022: live mode es el default. El bot Kotlin habla con la conversación REAL
de la app por un unix socket local — igual que el bot embebido oficial de
z.ai, que es un feature DENTRO de la app (`packages/services/src/bots/`) — en
vez del zoológico de sidecars/cola headless. Este canal (B3a) es la pieza del
lado fork: expone inbound, stream continuo y queries. El routing live/headless
es problema del daemon (B3b), no del canal.

**Qué se decidió acá:**

1. **El dueño del socket es el Host (utility process)**, junto a `BotsService`.
   Nunca el main de Electron. El socket vive y muere con el host: si el host
   muere, el archivo queda huérfano y el próximo arranque lo limpia; el daemon
   reconecta (el retry es del cliente — B3b).
2. **Transporte**: unix socket en `~/.zcode/daemon-local.sock` (respeta
   `ZCODE_DATA_BASE_DIR`), framing **JSONL** (un objeto JSON por línea,
   UTF-8, `\n`), línea ≤ 24 MiB.
3. **Auth obligatoria** (parity-and-engineering.md §5): token en
   `~/.zcode/daemon-local.token` (modo 0600, 64 hex, **rota en cada arranque
   del host**). El `hello` es la primera línea obligatoria; sin él en 10 s la
   conexión se cierra. Comparación timing-safe. El socket también es 0600 —
   solo el usuario dueño de la sesión puede siquiera conectarse (defensa en
   profundidad).
4. **El canal es una bot más del BotsService** — provider `"daemon"` en
   `botProviders` — con adapter **null**: las replies de
   `handleInboundMessage` vuelven por el socket como respuesta del request
   (no hay `send` de provider), y no participa del private-sync de replies
   formateadas (`privateSyncSupported` no lo lista). Se auto-provisiona
   **add-if-absent** en `bot-config.v3.json` (id `daemon-local`,
   providerUserId `daemon`, ya «bound»): si Damian la borra o deshabilita
   desde el diálogo de Bots, la decisión persiste — **esa es la gate**
   («gated like the other channels»). Kill-switch de emergencia:
   `ZCODE_DAEMON_LOCAL_CHANNEL=0`.
5. **Ventanas/host múltiple**: el primer host vivo gana el socket. Si al
   arrancar el archivo existe y responde al sondeo, este host NO lo toca
   (estado `conflict`, warn en el log) — tampoco rota el token, que pertenece
   al proceso que posee el socket.

## 2. Ciclo de vida y semántica de reconexión

| Evento | Qué pasa |
| --- | --- |
| Host arranca | socket + token nuevos; bot provisionada si falta |
| Daemon conecta | `hello` → `hello_ok` (o error fatal y close) |
| Host cierra limpio | `bye {reason:"host-shutdown"}` best-effort, close, unlink socket+token |
| Host muere de golpe | socket huérfano; el próximo arranque lo detecta (sondeo) y lo reemplaza; token nuevo ⇒ credencial vieja inservible |
| Daemon cae | el host sólo ve `close`; suscripciones del stream mueren con la conexión |

**In-flight (lo que B3b debe asumir):**

- `inbound` es **at-least-once** visto del lado del daemon: si la conexión
  muere después de que el prompt entró al CommandInbox pero antes de que la
  respuesta llegue, reenviar puede duplicar. Mitigación server-side: dedupe
  por `messageId` (TTL 2 min, paridad con la ventana de offset de Telegram) —
  el duplicado responde `inbound_result {duplicate:true, replies:[]}` y NO
  reenvía el prompt. El daemon igualmente debe deduplicar por `update_id`
  propio (misma doctrina F2d del bot Python).
- El stream es **continuous, sin replay**: eventos perdidos durante una
  desconexión NO se reenvían (línea roja de
  docs/zcode-agent-next-steps.md — nunca replayable en canal bot). Tras
  reconectar: re-`subscribe` + re-sincronizar estado con `taskSnapshot`.
  `seq` es monótono por conexión: si el daemon ve un salto, cayó algo —
  resincronizar.
- Requests sin respuesta (p. ej. `query` en vuelo al cortarse) se pierden;
  son idempotentes, se reintentan sin cuidado.
- `inbound_result` puede llegar **mucho después** (el turno puede tardar):
  correlacionar por `id`, no bloquear el pipeline del daemon esperándola —
  el render en vivo sale del stream, no de la reply.

## 3. Protocolo (v1)

### 3.1 Handshake

```json
→ {"type":"hello","protocolVersion":1,"token":"<64 hex>","clientId":"bot-kotlin"}
← {"type":"hello_ok","protocolVersion":1,
   "server":{"pid":1234,"startedAt":1761700000000,"appVersion":"3.16.2"},
   "bot":{"id":"daemon-local","enabled":true},
   "capabilities":["inbound","stream","queries:listTasks", ...]}
```

Errores del handshake (todos cierran la conexión): `auth_failed`,
`unsupported_version` (con `supported:[1]`), `auth_timeout` (sin hello en 10 s).
Un `hello` posterior re-envía `hello_ok` (idempotente, útil como health check).
`bot.enabled:false` significa que la gate está cerrada: los inbound devolverán
la reply de «bot disabled».

### 3.2 Inbound — texto libre al MISMO camino que el composer

```json
→ {"type":"inbound","id":"r1","text":"arreglá el login","messageId":"tg-1001",
   "attachments":[{"id":"a1","kind":"image","filename":"foto.png",
                   "mimeType":"image/png","dataBase64":"..."}],
   "receivedAt":1761700000123}
← {"type":"inbound_result","id":"r1","replies":[{"text":"..."}]}
```

- Va por `BotsService.handleInboundMessage` con actor
  `{provider:"daemon", botId:"daemon-local", providerUserId:"daemon",
  chatType:"private"}` ⇒ el MISMO pipeline del composer: draft/task,
  tombstone de tarea borrada, `sendPrompt` → V4 `sendText` → CommandInbox.
  Una tarea corriendo rechaza con la reply de «task running» (misma regla
  que el bot oficial).
- `commandText` opcional anula la detección de comandos (texto que empieza
  con `/` pero no es comando del botsService). Los `/comandos` que el
  botsService entiende (`/stop`, `/new`, `/status`, `/model`, `/approve`,
  `/deny`, `/bind`...) funcionan tal cual — **pero son del botsService**;
  los comandos del bot de Telegram (`/task`, `/deploy`, `/brain`...) los
  resuelve el daemon (B3b) y NUNCA deben forwardearse como texto.
- `attachments`: ≤ 4 × 5 MiB (límite del botsService), `dataBase64` o
  `localPath` (absoluto, legible por el host). El servicio los materializa
  en `bot-attachments/` — nunca en el workspace.
- Replies: `{text, locale?, selection?, elicitation?}` — lo que el daemon
  mostraría como burbuja de sistema (avisos, preguntas, teclados).

### 3.3 Stream continuo — bot-channel-continuous

```json
→ {"type":"subscribe","id":"s1","taskId":"task-9",
   "workspacePath":"/Users/damian/Projects/app"}
← {"type":"subscribed","id":"s1","taskId":"task-9"}
← {"type":"stream_event","taskId":"task-9","seq":1,"at":1761700004567,
   "event":{"type":"agent_thought_chunk","taskId":"task-9","traceId":"...",
            "parentToolUseId":null,"content":"penso que..."}}
→ {"type":"unsubscribe","id":"u1","taskId":"task-9"}
← {"type":"unsubscribed","id":"u1","taskId":"task-9"}
```

Suscribe vía `onDynamicTaskEvent(deliveryKind:"bot-channel-continuous")` —
**el mismo delivery que el bot embebido**, que a nivel agente proyecta como
`desktop-continuous` (zcodeTaskServiceAdapter.toZCodeDeliveryKind): deltas
incluidos, sin filtrado replayable. Re-subscribir la misma task reemplaza la
suscripción. `at` = hora de recepción del host (epoch ms) — los eventos V4
no llevan timestamp propio.

**Qué eventos llegan y cómo computar el progreso acumulado (MVP del owner:
«si es writing que aumente las líneas, si es thinking que aumente los chars,
todos con su timer»):**

| El daemon ve (ZCodeStreamEvent.type) | Viene de | Contador del daemon |
| --- | --- | --- |
| `agent_thought_chunk` (`content` delta, `parentToolUseId`) | reasoning_delta del modelo | chars de thinking += `content.length` (por agente: `parentToolUseId` nulo = main) |
| `agent_message_chunk` (`content` delta) | text_delta | chars de texto += length |
| `tool_call` (status implícito pending, `toolName`, `input:{}`) | `tool_input_start` | abre caja de herramienta: nombre = `toolName`, timer desde `at` |
| `tool_call_update` status `pending` + `input` parcial | `tool_input_delta` (proyectado con sampling ~1 s y presupuesto) | líneas escritas = line count de `input.content` (Write) / `input.new_string` (Edit); chars crudos = `raw.streamingRawInputLength` |
| `tool_call` final | model `tool_call` | input completo (autoridad) |
| `tool_call_update` status `completed/failed/denied/stopped` + `content` | tool execution | cierra caja; output en `content` |
| `task_run_started` | start de turno/insumo | inicia timer del turno |
| `task_complete` (`stopReason`, `usage`), `task_error` | fin de turno | sella cajas, emite resultado |
| `permission_request` / `elicitation_request` (+ sus responses) | bloqueos | 🔐/❓ del MVP; respuesta por `/approve` `/deny` o `/elicitation` como inbound |
| `usage_update`, `session_info_update`, `task_network_debug_status`, … | el resto del union `ZCodeStreamEvent` | /usage, /ctx, zconn episodes (parity §1) |

Subagentes en vivo: el MISMO stream; cada chunk/tool call lleva
`parentToolUseId` (id del tool call `Task` padre). Agrupar por ese id =
cajitas por agente. A nivel task-list, el padre de una task es
`forkedFromTaskId` (ver query `taskList`).

**Gaps documentados** (hoy solo en el sidecar live-io): nada. El sidecar
`live-io-*.jsonl` queda obsoleto para el daemon en live mode: CoT
(`agent_thought_chunk`) y tool-args (`tool_input_*` → proyección
`tool_call[_update]`, con `toolName` y `raw.streamingRawInputLength`) viajan
por el canal. La única pérdida vs el sidecar: el sidecar llevaba el raw
COMPLETO del tool-input; la proyección publica el input parseado
best-effort + el LARGO del raw (suficiente para contadores; el input
completo llega con el `tool_call` final).

**Latido («nunca silencio de radio»): decisión de diseño.** El canal NO
fabrica heartbeats sintéticos en el stream. El daemon: (a) tickea su
spinner/timer localmente (es estado de presentación — la línea parpadeante
del Python siempre tiqueó local), (b) usa `ping`→`pong {at}` (cada ~30 s)
como health-check del canal — distingue «canal sano pero el modelo no
emite» de «canal muerto». Razones: el stream debe reflejar EXACTAMENTE lo
que el desktop renderiza (una segunda serie de eventos sintéticos crearía
un dialecto propio y rompería la paridad desktop/daemon — la lección 4.5
del mapa); y un `tool_input_delta` ya trae muestreo ~1 s del agente.

### 3.4 Queries y control ops

```json
→ {"type":"query","id":"q1","query":{"kind":"quota"}}
← {"type":"query_result","id":"q1","result":{ ...UsageEntitlementSnapshot... }}
```

| `query.kind` | Servicio del fork | Comando del bot |
| --- | --- | --- |
| `listTasks {workspacePath, workspaceIdentity?}` | `listTasks` → `ZCodeTaskMeta[]` | `/task` (focused) |
| `taskList {listKind: pinned\|archived\|timeline\|active, workspaceScopes[], sortBy?, search?, limit?}` | `listTaskList` (global, con `forkedFromTaskId` para parents) | `/all_tasks`, búsqueda |
| `activeTaskIds {workspacePath}` | `listActiveTaskIds` — qué corre AHORA (sessions-index, no tasks-index) | `/status` («qué corre») |
| `taskMeta {taskId, workspacePath?}` | `getTaskMeta` (fallback: contexto del bot) | títulos/`hace cuánto` (`updatedAt`) |
| `taskSnapshot {taskId, messageLimit?, ...}` | `getTaskSnapshot` | resync post-reconexión, `/cot` (histórico) |
| `taskUsage {taskId, workspacePath?}` | `getTaskTokenUsage` | `/usage` `/ctx` |
| `quota {invalidateBalanceCache?}` | `IUsageStatsService.getEntitlementSnapshot` (5h pool, `remaining.percentage`, `nextResetTime`) | `/quota` |
| `botStatus {}` | bot daemon: config + contexto (workspace activo, mode, activeTaskId, pendings) | `/status` del canal |
| `stop {taskId, workspacePath?, runId?}` | `stopGeneration` — el MISMO V4 stop del botón de la UI (owner/lease/stale-run protection del lado servicio) | `/stop` |
| `stopAll {workspacePath?}` | `listActiveTaskIds` × `stopGeneration` | primera mitad de `/nuclear` |
| `compact {taskId, instructions?, expectedRevision?}` | `compactSession` | `/compact` |

`stop`/`stopAll` interrumpen el turno VISIBLE — el que muestra la pantalla.
La otra mitad de `/nuclear` (reiniciar el stack del bot, LaunchAgents, etc.)
es del daemon y NUNCA del canal: el canal no mata procesos de la app (la
regla de oro del 13/10 — el bot headless jamás mata a su host; ⌘Q sigue
siendo el gesto de Damian). No hay hoy un service op «restart app» ni hace
falta para el MVP; si B4 lo pide, se suma como query nueva del lado fork.

Errores: `unknown_query` (kind inválida), `internal` (falló la ejecución,
`message` con el detalle), `bad_request` (params). Sin `usageStatsService`
disponible, `quota` resuelve a `internal` con mensaje explícito.

### 3.5 Otros frames

`ping`→`pong {id, at}` (health-check). `error {id?, code, message?, fatal?}`:
`fatal:true` = el servidor cierra después. Errores de línea (JSON inválido)
NO cierran la conexión; los protocolos violados (sin hello, línea gigante)
sí.

## 4. Implementación (referencia)

- `packages/services/src/bots/daemonChannel.ts` — el servidor: socket, auth,
  dispatch, dedupe, suscripciones, queries. `createDaemonLocalChannel()`.
- `packages/services/src/node.ts` — wiring del Host: crea el canal con la
  MISMA instancia de `BotsService` registrada en la colección (+ task
  service + usage stats), lo arranca salvo `isDesktopAttachedRemote`, y lo
  dispone en `disposeServiceResources[AndWait]`.
- `packages/shared/src/daemon-channel.ts` — contrato (constantes + tipos).
- `packages/shared/src/bots.ts` — `botProviders` += `"daemon"`.
- `packages/services/src/bots/botsService.ts` — providers registry:
  `daemon: null`.
- UI: labels `bots.channel.daemon` (en-US/zh-CN) para que la bot
  provisionada se vea con nombre en el diálogo de Bots (y su toggle sea la
  gate visible).
- Tests: `packages/services/test/daemonChannel.test.ts` (herméticos: socket
  real en tmpdir, token real, cero red, cero `~/.zcode`).

## 5. Deploy

El pipeline del repo (`pnpm typecheck` + `pnpm lint` + vitest afectados) y el
deploy estándar del fork. **No correr `build-install.sh` desde el agente**
(reinicia la app que Damian está usando). Comando para cuando Damian pueda:

```
cd /Users/lattenero/Projects/ZCode && git pull --ff-only origin damian && \
  pnpm typecheck && pnpm lint && \
  npx vitest run packages/services/test/daemonChannel.test.ts && \
  scripts/build-install.sh --yes   # Damian hace ⌘Q cuando le avise
```

Verificación post-swap (`scripts/verify-deploy.sh` PASS) + handshake manual:

```
TOKEN=$(cat ~/.zcode/daemon-local.token)
printf '{"type":"hello","protocolVersion":1,"token":"%s","clientId":"smoke"}\n' "$TOKEN" \
  | nc -U ~/.zcode/daemon-local.sock | head -1      # → {"type":"hello_ok",...}
```

Rollback: cualquier build anterior del fork simplemente no tiene el canal —
el daemon verá `ECONNREFUSED`/archivo inexistente y degrada (el bot Kotlin
debe tratar «sin socket» como modo headless automático, no como error).
