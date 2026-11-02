# Upstream sync expedition — v3.16.2 → v3.17.1 (the merge plan)

Expedition report recovered verbatim from the OpenCode plan session «git diff zcode» and re-verified against the repo on 2026-11-02 before being archived here.

## 0. Provenance & verification

**Session**
- OpenCode session `ses_e63713227ffeXDxAmRuMKhwJrk` — «git diff zcode», agent `plan`, model `gemini-4-argon` (opencode-go, variant high), run 2026-11-02 10:59:26 → 11:28:00 (-03), directory `/Users/lattenero/Projects/ZCode`.
- Token ledger: 1,500,576 input / 15,244 output / 20,039 reasoning / 9,984,280 cache-read. Outcome: succeeded.

**Raw archive (the full 431K-token context)**
- `/Users/lattenero/Projects/git-diff-zcode.json` — full session export, 1.5MB, tool outputs complete.
- `/Users/lattenero/Projects/git-diff-zcode.json.gz` — gzip backup (480KB).
- `/Users/lattenero/Projects/git-diff-zcode.transcript.md` — readable transcript (tool outputs capped at 3000 chars; the JSON has them complete).
- Source of truth: `~/.local/share/opencode/opencode.db` (tables `session_v2` + `session_message`, 1.38MB of message data for this session).

**Verification performed 2026-11-02 (ZCode conversation, after recovery)**
- 57/57 session messages in the DB = 57 in the JSON export, zero ID diff → the export is complete; no blobs, no separate part store, nothing missing.
- The final report below is byte-identical to the session's last assistant message (only a trailing newline differs from the user's paste).
- Fork file list (`git diff --name-only 3c5b2276..damian`): **0 added / 0 removed** since the expedition → every conflict analysis below still applies.
- File count correction: the real count is **109 files (34 `[A]` + 75 `[M]`)**; the report's «107» undercounts by 2. The per-group analysis is unaffected.
- `upstream/main` unchanged at `a60ba6a7` (tag `v3.17.1`); merge-base unchanged at `3c5b2276` (v3.16.2). Only delta since the session: `f2f3df12` (FORK.md ledger, +1 line — Grupo 4 territory).
- Expedition scope sanity: upstream's `-611.504` lines come from Z.ai retiring all App unit tests on 26/10 (policy `docs/testing/unit-test-quality.md`); the `apps/zcode-cli` suite was NOT retired.

## 1. The expedition report (verbatim from the session)

Hice la expedición completa (100% read-only) comparando nuestra rama `damian` contra `upstream/main` (`a60ba6a7`, tag **`v3.17.1`** del 30/10) desde el `merge-base` común (`3c5b2276`, `v3.16.2` del 20/10).

---

## 1. Panorama General de la Expedición

- **`damian` (fork)**: 48 commits encima de `3c5b2276`, tocando **107 archivos** (34 creados `[A]` y 73 modificados `[M]`).
- **`upstream/main` (`v3.17.1`)**: 1 commit de sincronización (`a60ba6a7`) con **5.231 archivos cambiados** (`+216.552` / `-611.504` líneas).
- **¿Por qué `upstream/main` borró ~611k líneas?**
  El 26/10 Z.ai aplicó la política `docs/testing/unit-test-quality.md` (*"App 单测退役规格"*): **retiraron todos los unit tests de negocio de la App (`packages/*/test/*.test.ts` y `contract.test.ts`, ~1.800 archivos)** y quitaron `@testing-library/react` y `@testing-library/dom` de `packages/ui/package.json` y `pnpm-lock.yaml`.
  - En la raíz (`vitest.config.ts`) dejaron únicamente el proyecto `engineering` (lista cerrada de 141 archivos en `scripts/engineering-test-files.json`) y `packages/zcode-cua`.
  - **Importante**: la suite de **`apps/zcode-cli` NO fue retirada**; sigue intacta con su propio `apps/zcode-cli/vitest.config.ts`.

Al cruzar los **107 archivos del fork** contra `upstream/main`, quedan divididos exactamente en **4 grupos**:

| Grupo | Cantidad | Estado en un `git merge` |
| :--- | :---: | :--- |
| **Grupo 1 — `CONFLICT_MM`** (ambos modificaron las mismas líneas) | **9 archivos** | Conflicto de contenido (`<<<<<<<`) |
| **Grupo 2 — `SPECIAL [M / D]`** (el fork editó un test que upstream borró) + 10 tests nuevos del fork en `packages/*` | **7 archivos** (+10) | Conflicto `modify/delete` + pérdida de runner en `vitest.config.ts` |
| **Grupo 3 — `CLEAN_3WAY [M / M]`** (ambos tocaron el archivo en zonas distintas) | **28 archivos** | Fusiona sin conflicto textual, pero **hay 2 trampas semánticas** |
| **Grupo 4 — `ONLY_OURS`** (solo tocados/creados por el fork) | **63 archivos** | Fusiona directo, pero **hay 3 ajustes de gobernanza/scripts** |

---

## 2. Grupo 1: Los 9 Conflictos Directos (`CONFLICT_MM`) — Archivo por Archivo

### 1) `apps/zcode-cli/packages/adapters/tests/runner-retry.test.ts`
- **Qué tiene el fork**: 3 tests al final de `describe("calculateRetryDelay")` validando que `usageLimitResetWaitMs` (`next_flush_time`, Ola 5) saltea el tope de 5 minutos y tiene prioridad sobre `Retry-After`.
- **Qué trae ZCode (`v3.17.1`)**: Importa `vi` de `vitest` y agrega 2 tests en el mismo bloque validando que cuando `retry.jitter === true`, el `Retry-After` recibe un jitter hacia arriba de hasta +20% (tope +5s) para evitar estampidas 1302.
- **Trade-off (¿Fork, ZCode o Ambos?)**: **Ambos conviven sin tocarse**. En `runner-retry.ts` (que fusiona limpio), `usageLimitResetWaitMs` retorna antes de evaluar `Retry-After`; además, en producción el fork corre con `jitter: false` (`ZCODE_MODEL_RETRY_JITTER=0`), mientras que el test de upstream fuerza `jitter: true` localmente.
- **Resolución**: Conservar `vi` en el import y dejar los 3 tests del fork + los 2 tests de upstream.

---

### 2) `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
- **Qué tiene el fork (Ola 6b)**: En `case "model_retry_scheduled"`, pasa `reasonCode: modelRetryReasonCode(payload.reason)` y añade `reason: payload.reason` crudo (para que el pill v4 distinga `provider_overloaded`, `server_error` y `usage_limit_reset`).
- **Qué trae ZCode (`v3.17.1`)**: Cambia `reasonCode` a un ternario:
  ```ts
  reasonCode:
    payload.errorCode === ModelErrorCode.ModelRequestVerificationConfigNetwork
      ? ModelErrorCode.ModelRequestVerificationConfigNetwork
      : modelRetryReasonCode(payload.reason),
  ```
  (nuevo flujo de upstream para reintentar fallos de red al leer la configuración de seguridad/verificación antes de enviar el request al modelo).
- **Trade-off**: **Ambos son ortogonales y necesarios**. Si elegimos solo el fork, rompemos la detección de `ModelRequestVerificationConfigNetwork` en v4; si elegimos solo upstream, el pill del área de chat pierde `reason` crudo y vuelve a colapsar causas.
- **Resolución**: Usar el ternario de `reasonCode` de upstream **y** mantener `reason: payload.reason` del fork debajo.

---

### 3) `architecture-policy.yaml`
- **Qué tiene el fork**: 4 excepciones en `exceptions:`:
  - `fork-daemon-local-channel-new-files` (al inicio de `exceptions:`)
  - `conversation-verbosity-views-unmanaged-new` (al final)
  - `fork-model-retry-spawn-env-unmanaged-new` (al final)
  - `fork-usage-limit-reset-unmanaged-new` (al final)
- **Qué trae ZCode (`v3.17.1`)**: 7 excepciones nuevas al inicio de `exceptions:` y 12 excepciones nuevas al final (además de varios módulos `managed: true` nuevos arriba que fusionan limpio).
- **Hallazgo extra de la expedición**: `packages/ui/src/v4/forkCommandModel.ts` (creado en Ola 2) no estaba listado en las excepciones del fork; si se corre `architecture:check --changed` contra `3c5b2276`, falla por `unmanaged-new-file`.
- **Trade-off**: **Conservar todas las entradas de ambos lados**.
- **Resolución**: Unir las listas de `exceptions:` de upstream y del fork, y agregar `packages/ui/src/v4/forkCommandModel.ts` a las excepciones del fork.

---

### 4) `packages/ui/src/SlashCommandPlugin.tsx`
- **Qué tiene el fork (Ola 2)**: Invierte la precedencia entre comandos de la App (`appCommands`) y comandos del catálogo CLI (`commands`): calcula `appValues = new Set(appSuggestions.map(i => i.value))` y filtra `cliSuggestions` con `!appValues.has(item.value)`. Así el `/diff` client-side del fork eclipsa al `/diff` del CLI (que gastaba un turno del modelo).
- **Qué trae ZCode (`v3.17.1`)**: Agrega soporte para un flag `recovery?: boolean` en `AppSlashCommand` (usado por el nuevo comando `/reload`), y solo deja que los comandos con `recovery: true` (`recoveryNames`) eclipsen al CLI (`!recoveryNames.has(item.value)`).
- **Trade-off**: La regla del fork (`!appValues.has(item.value)`) **es un superconjunto exacto** de la de upstream (`recoveryNames ⊆ appValues`). Como `/side` y `/btw` ya se filtran previamente en `SessionPane.tsx` cuando existen en `cliSlashCommandNames`, hacer que todos los `appCommands` visibles eclipsen homónimos del CLI hace funcionar **tanto `/diff` (del fork) como `/reload` (de upstream)**.
- **Resolución**: Mantener la precedencia del fork (`!appValues.has(item.value)`).

---

### 5) `packages/ui/src/chat-input-toolbar/display.tsx`
- **Qué tiene el fork (Ola 4b/6)**: En `ChatApiRetryStatus`, usa `{ id: apiRetryStatusMessageId(apiRetry.reason) }` (labels honestos por causa) y renderiza al lado el countdown `mm:ss` (`useRetryCountdown(apiRetry?.nextRetryAtMs)`).
- **Qué trae ZCode (`v3.17.1`)**: Importa `zcodeProviderRuntimeHeadersErrorCode` y, cuando `apiRetry.error === zcodeProviderRuntimeHeadersErrorCode.configNetwork`, muestra el mensaje `"chat.configReadRetryStatus"` (*reintentando lectura de configuración*).
- **Trade-off**: **Hacer funcionar ambos**. Si un reintento es por `configNetwork` (fallo antes del request al modelo), debe verse `"chat.configReadRetryStatus"`; para todos los demás casos debe seguir aplicando la tabla `API_RETRY_REASON_MESSAGE_IDS` del fork + el countdown.
- **Resolución**:
  1. Conservar el import `zcodeProviderRuntimeHeadersErrorCode` de upstream.
  2. Agregar `[zcodeProviderRuntimeHeadersErrorCode.configNetwork]: "chat.configReadRetryStatus"` a `API_RETRY_REASON_MESSAGE_IDS` y en `ChatApiRetryStatus` pasar `apiRetry.error === zcodeProviderRuntimeHeadersErrorCode.configNetwork ? zcodeProviderRuntimeHeadersErrorCode.configNetwork : apiRetry.reason` a `apiRetryStatusMessageId(...)`, manteniendo intacto el `countdownLabel`.

---

### 6) `packages/ui/src/v4/ConversationTimeline.tsx` *(acoplado con #9)*
- **Qué tiene el fork (Ola Verbosity)**: Extrae `messageStreamVerbosity` y `messageStreamExpandedByDefault` de `rowContext` y los pasa a `buildConversationTurnRenderUnits(rows, { ... })`.
- **Qué trae ZCode (`v3.17.1`)**: Reemplaza `buildConversationTurnRenderUnits(rows, ...)` + `withTopicPreparationMessages` por el nuevo pipeline particionado `rowsPartition = getConversationRowsPartition(rows)` → `selectRenderUnits = createConversationTurnRenderUnitsSelector()` → `withTopicPreparationUnits(selectRenderUnits(rowsPartition, { ... }))`, que devuelve `{ history, tail }` y evita recalcular toda la historia en cada token de streaming.
- **Trade-off**: **Ambos son indispensables**. No podemos quedarnos con `buildConversationTurnRenderUnits` en `ConversationTimeline.tsx` porque el resto del componente en `v3.17.1` consume la partición `{ history, tail }` y porque la mejora de performance en conversaciones largas es enorme; y no podemos perder `verbosity` / `expandAllByDefault`.
- **Resolución**: Usar `withTopicPreparationUnits(selectRenderUnits(rowsPartition, { nowMs: liveNowMs, sessionPhase, pluginUiPinResolver, ...(messageStreamVerbosity ? { verbosity: messageStreamVerbosity } : {}), ...(messageStreamExpandedByDefault ? { expandAllByDefault: true } : {}) }), rows, topicPreparations)` e incluir todas las dependencias en el `useMemo`. *(Ver #9 para la invalidación de caché dentro del selector).*

---

### 7) `packages/ui/src/v4/ConversationTurnGroup.tsx`
- **Qué tiene el fork (Ola Verbosity)**:
  - Separa `assistantHistoryLockedOpen` (hecho diagnóstico: turno corriendo, fallo/interrupción, o turno de 1 segmento sin texto final → **bloqueado abierto**) de `assistantHistoryDefaultOpen` (preferencia de usuario `verbose` / `expandAllByDefault` → **abre por defecto pero permite cerrarlo manualmente**):
    ```ts
    const historyLockedOpen =
      segment.assistantHistoryLockedOpen ?? segment.assistantHistoryDefaultOpen;
    const open = historyLockedOpen || historyOpen;
    // ...
    onOpenChange={historyLockedOpen ? undefined : setHistoryOpen}
    ```
- **Qué trae ZCode (`v3.17.1`)**:
  - Pasa `turnRunning={unit.isRunning}` a `ConversationWorkSegmentFlow` y escribe:
    ```ts
    const open = turnRunning || segment.assistantHistoryDefaultOpen || historyOpen;
    // ...
    onOpenChange={turnRunning || segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen}
    ```
- **Trade-off**: Si usáramos la línea de upstream tal cual (`turnRunning || segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen`), cuando el usuario activa `Verbose` o `Expandir todo` (`assistantHistoryDefaultOpen = true`, `assistantHistoryLockedOpen = false`), **`onOpenChange` quedaría en `undefined` y ningún turno histórico podría colapsarse manualmente**, rompiendo la spec del fork (`docs/specs/conversation-verbosity-views.md` §2).
- **Resolución**: Combinar ambos conceptos:
  ```ts
  const historyLockedOpen =
    turnRunning || (segment.assistantHistoryLockedOpen ?? segment.assistantHistoryDefaultOpen);
  const open = historyLockedOpen || historyOpen;
  // ...
  onOpenChange={historyLockedOpen ? undefined : setHistoryOpen}
  ```
  Así `turnRunning` bloquea abierto (como pide upstream) y `assistantHistoryLockedOpen` distingue bloqueo diagnóstico de apertura por preferencia (como pide el fork).

---

### 8) `packages/ui/src/v4/SessionPane.tsx`
- **Qué tiene el fork (Ola 2)**:
  - En `appSlashCommands`, define `diffAction` (`/diff` client-side cuando `sessionId && !compactForRemoteControl`) y arma `baseActions = diffAction ? [planAction, diffAction] : [planAction]`.
  - En `planAction`, tenía `label: intl.formatMessage({ id: "chat.slash.app.plan.label" })`.
- **Qué trae ZCode (`v3.17.1`)**:
  - Borra la key i18n `"chat.slash.app.plan.label"` de `en-US.ts` y `zh-CN.ts` y quita `label` de `planAction`.
  - Agrega `reloadActions` (`/reload` con `recovery: true` → `taskRestart.restart`).
- **Trade-off**: **Ambos comandos (`/reload` y `/diff`) deben estar disponibles**, y debemos quitar `label` de `planAction` porque la key i18n ya no existe en los diccionarios de `v3.17.1`.
- **Resolución**:
  - Quitar `label` de `planAction`.
  - Definir `const baseActions = [...reloadActions, planAction, ...(diffAction ? [diffAction] : [])];` y devolver `baseActions` (o `[...baseActions, ...sideCommands]`).
  - En el array de dependencias del `useMemo`, conservar tanto `taskRestart.restart` (upstream) como `openDiffAskPanel` y `compactForRemoteControl` (fork).

---

### 9) `packages/ui/src/v4/conversationTurnRenderUnits.ts` *(¡Cuidado especial acá!)*
- **Qué tiene el fork (Ola Verbosity)**:
  - En `materializeDraftUnit` y `normalizeRenderUnitPosition`, calcula `assistantHistoryDefaultOpen` y `assistantHistoryLockedOpen` mediante `resolveAssistantHistoryOpenState(...)` leyendo `options.verbosity` y `options.expandAllByDefault`.
- **Qué trae ZCode (`v3.17.1`)**:
  1. En `normalizeRenderUnitPosition`, evita hacer `unit.workSegments?.map(...)` antes del `if (...) return unit;` para no alocar arrays en cada frame cuando nada cambió.
  2. Agrega `createConversationTurnRenderUnitsSelector()`, que cachea las unidades de `partition.history` y de cada `DraftTurnRenderUnit`.
- **Trampa semántica detectada en la expedición**:
  El nuevo `createConversationTurnRenderUnitsSelector()` de upstream decide si reutiliza la caché (`isHistoryReusable`, `materializeReusing` y `history.tailDropped`) mirando solo `rows`, `sessionPhase`, `nowMs` y `pluginUiPinResolver`. **No mira `options.verbosity` ni `options.expandAllByDefault`**. Si no agregamos esos dos campos a las condiciones de reuso del selector, cambiar la verbosidad o el switch "Expandir todo" en vivo **no actualizaría los turnos históricos ya cacheados**.
- **Resolución (Ambos + caché consciente de verbosidad)**:
  1. En `normalizeRenderUnitPosition`: calcular `unitOpenState` y `lastSegmentOpenState` con `resolveAssistantHistoryOpenState(...)` **antes** del `if (...) return unit;` sin clonar `workSegments`, y solo hacer `.map(...)` después del `if` cuando efectivamente cambió `isLastTurn`, `defaultOpen` o `lockedOpen`.
  2. En `createConversationTurnRenderUnitsSelector()`: guardar `verbosity` y `expandAllByDefault` en `Entry`, `HistoryCache` y `history.tailDropped`, e incluirlos en `unchanged` y en `isHistoryReusable`.

---

## 3. Grupo 2: Los 7 Conflictos `modify/delete` (`SPECIAL [M / D]`) y la Suite de Tests del Fork

Como Z.ai borró todos los unit tests de `packages/{ui,services,shared,desktop}/test/` en `v3.17.1`, tenemos:
- **7 archivos en conflicto `modify/delete` (`[M / D]`)** (tests de upstream que el fork había ampliado):
  1. `packages/desktop/test/desktopRuntimeEnv.test.ts` (Ola 8: `production` → `alwaysOn`)
  2. `packages/services/test/highspeedCardService.test.ts` (Ola 3: retry 502 `[1s, 3s]` + `draw-miss` en presupuesto)
  3. `packages/services/test/zcodeStdioTransport.test.ts` (fix 30/10: listener que tira excepción no mata el stdio transport)
  4. `packages/shared/test/appSettings.test.ts` (Ola Verbosity: schema de `messageStreamVerbosity` / `messageStreamExpandedByDefault`)
  5. `packages/ui/test/v4ConversationTurnRenderUnits.test.ts` (Ola Verbosity: 7 tests de `summary`/`normal`/`verbose` + `lockedOpen`)
  6. `packages/ui/test/useUiPluginRecommendations.test.ts` (Ola 1: card de Diff Ask prepended)
  7. `packages/ui/test/v4ConversationStatusPanelGitReview.test.ts` (Ola 1: botón Changes → Diff Ask)
- **10 archivos de test creados por el fork (`[A / -]`) en `packages/*`**:
  - En `services`: `daemonChannel.test.ts` (**30 tests del canal B3a**), `forkModelRetrySpawnEnv.test.ts`, `subagentLaunchAck.test.ts`.
    *(Ojo: `daemonChannel.test.ts` importa `./botsService.fixtures.js`, que upstream borró porque no fue tocado por el fork; si conservamos `daemonChannel.test.ts`, hay que conservar también `packages/services/test/botsService.fixtures.ts`).*
  - En `shared`: `zcodeApiRetryStatus.test.ts`, `zcodeSessionEventTolerance.test.ts`.
  - En `ui`: `chatApiRetryCountdown.test.ts`, `conversationExpandDefaultStore.test.ts`, `forkCommandModel.test.ts`, `reasoningExpandDefault.test.ts`, `toolLayoutDefaultOpen.test.ts`.
- *(Recordatorio: los 9 archivos de tests del fork dentro de `apps/zcode-cli/` **siguen funcionando sin cambios** porque el CLI no retiró sus tests).*

### Las opciones y su Trade-off para los tests de `packages/*`:

#### Opción A (Recomendada): Conservar los 17 tests del fork bajo un `vitest.fork.config.ts` dedicado
- **Cómo funciona**:
  - Aceptamos el borrado de los ~1.800 tests de upstream (no mantenemos tests ajenos que Z.ai abandonó).
  - Conservamos los **17 archivos de test que prueban features propios del fork** (los 10 `[A]` + los 7 `[M/D]` + `packages/services/test/botsService.fixtures.ts`).
  - Dejamos `vitest.config.ts` y `scripts/engineering-test-files.json` **100% idénticos a upstream** (para que los gates `pnpm test:architecture` y `pnpm test:engineering-tools` de upstream pasen sin fricción), y creamos un archivo nuevo del fork `vitest.fork.config.ts` que incluye únicamente los 17 tests del fork.
  - Actualizamos `scripts/sync-upstream.nu` para que corra `vitest run -c vitest.fork.config.ts`.
- **Sub-decisión sobre `@testing-library/react` (5 de los 17 tests)**:
  Upstream eliminó `@testing-library/react` y `@testing-library/dom` de `packages/ui/package.json` y `pnpm-lock.yaml`. Cinco tests de UI del fork (`chatApiRetryCountdown`, `reasoningExpandDefault`, `toolLayoutDefaultOpen`, `useUiPluginRecommendations`, `v4ConversationStatusPanelGitReview`) lo importan:
  - **Variante A1 (Limpia a futuro — recomendada)**: Reemplazar en esos 5 archivos el helper de `@testing-library/react` por un mini-helper local con `createRoot` de `react-dom/client` + `act` de `react` (usando `jsdom`, que **sí sigue** en el `package.json` raíz de upstream). **Ventaja enorme**: `packages/ui/package.json` y `pnpm-lock.yaml` (30.000+ líneas) quedan **100% idénticos a upstream** y nunca darán conflicto en futuros syncs.
  - **Variante A2**: Re-agregar `@testing-library/react` y `@testing-library/dom` a `packages/ui/package.json` y correr `pnpm install`. **Desventaja**: `pnpm-lock.yaml` queda modificado en el fork y dará conflicto en cada sync futuro.

#### Opción B: Seguir la doctrina de upstream al 100% en `packages/*` o conservar solo los 12 tests sin DOM
- Conservar únicamente los 12 tests del fork que no usan `@testing-library/react` (incluyendo los 30 tests críticos de `daemonChannel.test.ts`, `zcodeSessionEventTolerance.test.ts`, `v4ConversationTurnRenderUnits.test.ts`, `forkCommandModel.test.ts`, `highspeedCardService.test.ts`, etc.) y retirar los 5 que montaban DOM con `@testing-library/react`.

---

## 4. Grupo 3: Los 28 Archivos `CLEAN_3WAY [M / M]` (Fusiones Automáticas Auditadas)

Revisé el diff de ambos lados en los **28 archivos** donde Git hace el merge 3-way sin conflictos textuales.
- **26 de los 28 archivos son 100% compatibles semánticamente** (por ejemplo: `.husky/pre-push`, `failure-classifier.ts`, `model-execution.ts`, `runner-generate.ts`, `runner-retry.ts`, `runner-stream.ts`, `runner.test.ts`, `contracts/src/model/index.ts`, `turn-model-step.ts`, `runtime-stream-recovery.test.ts`, `node.ts`, `zcodeAgentService.ts`, `zcodeTaskServiceAdapter.ts`, `shared/src/*`, `SettingsPage.tsx`, `en-US.ts`, `zh-CN.ts`, `ConversationRowView.tsx`, `V4ComposerToolbar.tsx`, `conversationTurnRenderUnitTypes.ts`, `conversationTurnWorkSegments.ts`).
- **2 detalles semánticos detectados al cruzar `CLEAN_3WAY` con `CONFLICT_MM`**:
  1. En `packages/ui/src/v4/ConversationTurnGroup.tsx`:
     - En `TurnChatLoadingSlot`: upstream cambió la condición de visibilidad a `apiRetry?.reasonCode === zcodeProviderRuntimeHeadersErrorCode.configNetwork || retryStatus.attempt >= MIN_VISIBLE_API_RETRY_ATTEMPT`. Con `MIN_VISIBLE_API_RETRY_ATTEMPT = 1` del fork (Ola 7), ambas ramas quedan satisfechas desde el intento 1/10.
     - En `ConversationBackgroundResultWork`: upstream envolvió el bloque de resultado background en un `<Collapsible>` construyendo un `historySegment: ConversationTurnWorkSegment`. Conviene pasar también `...(unit.assistantHistoryLockedOpen !== undefined ? { assistantHistoryLockedOpen: unit.assistantHistoryLockedOpen } : {})` en ese `historySegment` para que el chevron de `AssistantHistoryStatus` se comporte igual que en los turnos normales.
  2. En `packages/ui/src/v4/SessionPane.tsx`:
     - Upstream introdujo `modelSelectionDisplayView` para las props de render (mientras mantiene `modelSelectionView` para las operaciones de envío). En nuestro bloque de `resolveCommandModelSelection` (Ola 2, dentro de `dispatchSendTextAfterConfig`), seguimos usando `view: modelSelectionView` (que sigue existiendo en scope y ya está en el array de dependencias del `useCallback`), por lo que compila y funciona sin cambios.

---

## 5. Grupo 4: Los 63 Archivos `ONLY_OURS` — 3 Ajustes de Higiene y Gobernanza

Aunque estos 63 archivos no tienen conflicto con upstream, la expedición detectó **3 puntos** que debemos ajustar al cerrar el merge para que todos los gates (`pnpm lint`, `pnpm typecheck`, `pnpm architecture:check --changed`) pasen en verde:

1. **`packages/services/src/bots/daemonChannel.ts` supera hoy el límite de 800 líneas de `oxlint`**:
   - Tras los commits de `respond` (`6993d7e8`) y `steer` (`7ae1a972`), `daemonChannel.ts` quedó en 1.019 líneas efectivas (máximo 800 en `.oxlintrc.json`) y tiene un `type ZCodePermissionResponse` importado sin usar, haciendo que `pnpm lint` falle hoy con 1 error y 1 warning.
   - **Solución**: quitar el import `ZCodePermissionResponse` sin usar y agregar `/* oxlint-disable eslint(max-lines) -- ... */` en el encabezado de `daemonChannel.ts` (o extraer los handlers de `respond`/`steer` junto a `daemonChannelModelSelection.ts`), exactamente igual que `botsService.ts`, `zcodeAgentService.ts` y `node.ts`.
2. **`packages/ui/test/chatApiRetryCountdown.test.ts`**:
   - Tiene un warning de `oxlint` por `import type { ApiRetryState } from "@zcode/shared"` sin usar; conviene limpiarlo.
3. **`scripts/sync-upstream.nu`**:
   - En la línea 42 ejecuta `packages/ui/test/useRecommendedUiPlugins.test.ts` (borrado por upstream) sin `-c vitest.fork.config.ts`. Lo actualizaremos para que corra la suite del fork con la nueva configuración.

---

## 6. Plan de Ejecución Paso a Paso (para cuando pasemos a modo Build)

1. **Fetch & Merge sin commit (`git merge --no-commit upstream/main`)** sobre `damian`.
2. **Resolver los 9 conflictos `CONFLICT_MM`** aplicando las fusiones exactas del **Punto 2** (incluyendo la invalidación de caché por `verbosity`/`expandAllByDefault` en `createConversationTurnRenderUnitsSelector`).
3. **Resolver los 7 conflictos `SPECIAL [M / D]` + `botsService.fixtures.ts`** según la opción que elijas en el **Punto 3** y crear `vitest.fork.config.ts`.
4. **Aplicar los 3 ajustes de higiene del Punto 5** (`daemonChannel.ts` lint, `forkCommandModel.ts` en `architecture-policy.yaml`, y `scripts/sync-upstream.nu`).
5. **Correr la batería completa de verificación**:
   - `pnpm typecheck` (raíz)
   - `tsc --noEmit` en `apps/zcode-cli/packages/{contracts,adapters,core,bootstrap,tui,i18n}`
   - `pnpm lint` (`oxlint`, 0 errores)
   - `pnpm architecture:check --changed` y `pnpm test:architecture`
   - Suites de Vitest del CLI (`apps/zcode-cli`: `runner-retry`, `runner`, `failure-classifier`, `failure-usage-limit-reset`, `runner-usage-limit-segments`, `live-cot-tap`, `skills`, `runtime-stream-recovery`, `tui-network-retry-copy`)
   - Suites de Vitest del fork (`vitest.fork.config.ts`: `daemonChannel`, `zcodeStdioTransport`, `highspeedCardService`, `v4ConversationTurnRenderUnits`, etc.)
6. **Commit del merge + actualización del ledger en `FORK.md`** (listo para `build-install.nu`).

---

### Pregunta para definir antes de ejecutar

Para el **Grupo 2 (los tests del fork en `packages/*` tras el retiro de App unit tests en upstream)**, ¿confirmamos ir por la **Opción A1** (conservar los 17 tests propios del fork + `botsService.fixtures.ts` bajo `vitest.fork.config.ts`, y pasar los 5 tests de UI a `react-dom/client` para mantener `packages/ui/package.json` y `pnpm-lock.yaml` **100% idénticos a upstream**)?

---

## Appendix A — the full expedition command trail

Every tool invocation, in session order (full outputs live in the raw archive):

     1	**`shell`** `git status -sb && git remote -v && git branch -a`
     2	**`shell`** `git log -n 5 --oneline --decorate damian && git log -n 5 --oneline --decorate main && git log -n 5 --oneline --decorate upstream/main && git rev-list --left-right --count damian...upstream/main`
     3	**`shell`** `git log -n 3 --format="%ci %h %s" upstream/main && git ls-remote upstream refs/heads/main refs/tags/*`
     4	**`shell`** `git ls-remote upstream refs/heads/main 'refs/tags/*'`
     5	**`shell`** `git diff --name-status 3c5b2276..damian`
     6	**`shell`** `git diff --stat 3c5b2276..upstream/main | tail -n 5 && comm -12 <(git diff --name-only 3c5b2276..damian | sort) <(git diff --name-only 3c5b2276..upstream/main | sort)`
     7	**`read`** `FORK.md`
     8	**`read`** `docs/fork/ARCHITECTURE.md`
     9	**`read`** `scripts/sync-upstream.nu`
    10	**`read`** `docs/fork/DAEMON-CHANNEL.md`
    11	**`read`** `docs/fork/TESTING.md`
    12	**`shell`** `git log --oneline 3c5b2276..damian`
    13	**`shell`** `python3 -c ' ⏎ import subprocess, tempfile, os ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎ theirs = "upstream/main" ⏎  ⏎ def get_status(rev_range): ⏎     out = subprocess.check_output(["git", "diff", "--no-renames", "--name-status", rev_range], text=True) ⏎     res = {} ⏎     for line in out.strip().splitlines(): ⏎         if not line: continue ⏎         st, path = line.split("\t", 1) ⏎         res[path] = st ⏎     return res ⏎  ⏎ ours_st = get_status(f"{base}..{ours}") ⏎ theirs_st = get_status(f"{base}..{theirs}") ⏎  ⏎ for path, ost in sorted(ours_st.items()): ⏎     tst = theirs_st.get(path, "-") ⏎     if tst == "-": ⏎         print(f"ONLY_OURS  [{ost} / -] {path}") ⏎     else: ⏎         # Check if 3-way merge-file cleanly merges or conflicts ⏎         if ost == "M" and tst == "M": ⏎             with tempfile.TemporaryDirectory(dir="/private/var/folders/mt/6n_kh76x031gg9r6hx0y_nmr0000gn/T/opencode") as d: ⏎                 for name, rev in [("base", base), ("ours", ours), ("theirs", theirs)]: ⏎                     blob = subprocess.check_output(["git", "show", f"{rev}:{path}"]) ⏎                     with open(os.path.join(d, name), "wb") as f: ⏎                         f.write(blob) ⏎                 rc = subprocess.call(["git", "merge-file", "-q", os.path.join(d, "ours"), os.path.join(d, "base"), os.path.join(d, "theirs")]) ⏎                 state = "CONFLICT_MM" if rc != 0 else "CLEAN_3WAY " ⏎                 print(f"{state} [{ost} / {tst}] {path}") ⏎         else: ⏎             print(f"SPECIAL    [{ost} / {tst}] {path}") ⏎ '`
    14	**`shell`** `git diff --dirstat=files,1 3c5b2276..upstream/main && git diff --diff-filter=D --name-only 3c5b2276..upstream/main | cut -d/ -f1-3 | sort | uniq -c | sort -nr | head -n 30`
    15	**`shell`** `git show upstream/main:vitest.config.ts && git show upstream/main:package.json`
    16	**`shell`** `git show upstream/main:scripts/engineering-test-files.json && git show upstream/main:scripts/test/retired-app-unit-evidence.test.mjs && git show upstream/main:AGENTS.md`
    17	**`shell`** `git show upstream/main:docs/testing/unit-test-quality.md && git show upstream/main:scripts/lib/retired-app-unit-evidence.mjs`
    18	**`shell`** `git show upstream/main:scripts/test/architecture-governance.test.mjs upstream/main:scripts/test/architecture-upstream-admission.test.mjs upstream/main:scripts/test/source-size-policy.test.mjs`
    19	**`shell`** `git show upstream/main:.oxlintrc.json && wc -l $(git diff --name-only 3c5b2276..damian) | sort -nr | head -n 30`
    20	**`shell`** `git diff 3c5b2276..upstream/main -- .oxlintrc.json && npx oxlint packages/services/src/bots/daemonChannel.ts`
    21	**`shell`** `pnpm lint`
    22	**`shell`** `head -n 5 packages/services/src/bots/botsService.ts`
    23	**`shell`** `git grep max-lines`
    24	**`shell`** `python3 -c ' ⏎ import subprocess, tempfile, os ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎ theirs = "upstream/main" ⏎  ⏎ conflicts = [ ⏎     "apps/zcode-cli/packages/adapters/tests/runner-retry.test.ts", ⏎     "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts", ⏎     "architecture-policy.yaml", ⏎     "packages/ui/src/SlashCommandPlugin.tsx", ⏎     "packages/ui/src/chat-input-toolbar/display.tsx", ⏎     "packages/ui/src/v4/ConversationTimeline.tsx", ⏎     "packages/ui/src/v4/ConversationTurnGroup.tsx", ⏎     "packages/ui/src/v4/SessionPane.tsx", ⏎     "packages/ui/src/v4/conversationTurnRenderUnits.ts", ⏎ ] ⏎  ⏎ with tempfile.TemporaryDirectory(dir="/private/var/folders/mt/6n_kh76x031gg9r6hx0y_nmr0000gn/T/opencode") as d: ⏎     for path in conflicts: ⏎         for name, rev in [("base", base), ("ours", ours), ("theirs", theirs)]: ⏎             blob = subprocess.check_output(["git", "show", f"{rev}:{path}"]) ⏎             with open(os.path.join(d, name), "wb") as f: ⏎                 f.write(blob) ⏎         p = subprocess.run( ⏎             ["git", "merge-file", "-p", "-L", "damian (fork)", "-L", "base (3c5b2276)", "-L", "upstream/main (v3.17.1)", ⏎              os.path.join(d, "ours"), os.path.join(d, "base"), os.path.join(d, "theirs")], ⏎              text=True, capture_output=True ⏎         ) ⏎         lines = p.stdout.splitlines() ⏎         print(f"=== FILE: {path} (exit={p.returncode}) ===") ⏎         in_conflict = False ⏎         start_idx = 0 ⏎         for i, line in enumerate(lines): ⏎             if line.startswith("<<<<<<< "): ⏎                 in_conflict = True ⏎                 start_idx = max(0, i - 5) ⏎                 for ctx in lines[start_idx:i]: ⏎                     print(f"  {ctx}") ⏎             if in_conflict: ⏎                 print(f"! {line}") ⏎             if line.startswith(">>>>>>> "): ⏎                 in_conflict = False ⏎                 for ctx in lines[i+1:min(len(lines), i+6)]: ⏎                     print(f"  {ctx}") ⏎                 print("---") ⏎ '`
    25	**`shell`** `python3 -c ' ⏎ import subprocess ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎ theirs = "upstream/main" ⏎  ⏎ conflicts = [ ⏎     "apps/zcode-cli/packages/adapters/tests/runner-retry.test.ts", ⏎     "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts", ⏎     "packages/ui/src/SlashCommandPlugin.tsx", ⏎     "packages/ui/src/chat-input-toolbar/display.tsx", ⏎     "packages/ui/src/v4/ConversationTimeline.tsx", ⏎     "packages/ui/src/v4/ConversationTurnGroup.tsx", ⏎     "packages/ui/src/v4/SessionPane.tsx", ⏎     "packages/ui/src/v4/conversationTurnRenderUnits.ts", ⏎ ] ⏎  ⏎ for path in conflicts: ⏎     print("=================================================================") ⏎     print(f"FILE: {path}") ⏎     print("--- OURS (3c5b2276..damian) ---") ⏎     print(subprocess.check_output(["git", "diff", "-U5", f"{base}..{ours}", "--", path], text=True)) ⏎     print("--- THEIRS (3c5b2276..upstream/main) ---") ⏎     print(subprocess.check_output(["git", "diff", "-U5", f"{base}..{theirs}", "--", path], text=True)) ⏎ '`
    26	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c94a0c2002A4LCDQOYakUFRD.out`
    27	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c94a0c2002A4LCDQOYakUFRD.out`
    28	**`shell`** `python3 -c ' ⏎ import subprocess ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎ theirs = "upstream/main" ⏎  ⏎ clean_files = [ ⏎     ".husky/pre-push", ⏎     "apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts", ⏎     "apps/zcode-cli/packages/adapters/src/model/model-execution.ts", ⏎     "apps/zcode-cli/packages/adapters/src/model/runner-generate.ts", ⏎     "apps/zcode-cli/packages/adapters/src/model/runner-retry.ts", ⏎     "apps/zcode-cli/packages/adapters/src/model/runner-stream.ts", ⏎     "apps/zcode-cli/packages/adapters/tests/runner.test.ts", ⏎     "apps/zcode-cli/packages/contracts/src/model/index.ts", ⏎     "apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts", ⏎     "apps/zcode-cli/packages/core/tests/runtime-stream-recovery.test.ts", ⏎     "docs/highspeed/highspeed-card-spec.md", ⏎     "packages/services/src/node.ts", ⏎     "packages/services/src/zcode-agent/zcodeAgentService.ts", ⏎     "packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts", ⏎     "packages/shared/src/index.ts", ⏎     "packages/shared/src/protocol.ts", ⏎     "packages/shared/src/test-ids.ts", ⏎     "packages/shared/src/validationAppSettings.ts", ⏎     "packages/shared/src/zcode-protocol-legacy-types.ts", ⏎     "packages/shared/src/zcode-protocol-v4/snapshot.ts", ⏎     "packages/shared/src/zcode-protocol/index.ts", ⏎     "packages/ui/src/SettingsPage.tsx", ⏎     "packages/ui/src/i18n/locales/en-US.ts", ⏎     "packages/ui/src/i18n/locales/zh-CN.ts", ⏎     "packages/ui/src/v4/ConversationRowView.tsx", ⏎     "packages/ui/src/v4/composer/V4ComposerToolbar.tsx", ⏎     "packages/ui/src/v4/conversationTurnRenderUnitTypes.ts", ⏎     "packages/ui/src/v4/conversationTurnWorkSegments.ts", ⏎ ] ⏎  ⏎ for path in clean_files[:14]: ⏎     print("=================================================================") ⏎     print(f"CLEAN_3WAY FILE: {path}") ⏎     print("--- OURS (3c5b2276..damian) ---") ⏎     print(subprocess.check_output(["git", "diff", "-U3", f"{base}..{ours}", "--", path], text=True)) ⏎     print("--- THEIRS (3c5b2276..upstream/main) ---") ⏎     print(subprocess.check_output(["git", "diff", "-U3", f"{base}..{theirs}", "--", path], text=True)) ⏎ '`
    29	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c95170f001eVJSKeGPR01x0p.out`
    30	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c95170f001eVJSKeGPR01x0p.out`
    31	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c95170f001eVJSKeGPR01x0p.out`
    32	**`shell`** `python3 -c ' ⏎ import subprocess ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎ theirs = "upstream/main" ⏎  ⏎ clean_files_2 = [ ⏎     "packages/shared/src/index.ts", ⏎     "packages/shared/src/protocol.ts", ⏎     "packages/shared/src/test-ids.ts", ⏎     "packages/shared/src/validationAppSettings.ts", ⏎     "packages/shared/src/zcode-protocol-legacy-types.ts", ⏎     "packages/shared/src/zcode-protocol-v4/snapshot.ts", ⏎     "packages/shared/src/zcode-protocol/index.ts", ⏎     "packages/ui/src/SettingsPage.tsx", ⏎     "packages/ui/src/i18n/locales/en-US.ts", ⏎     "packages/ui/src/i18n/locales/zh-CN.ts", ⏎     "packages/ui/src/v4/ConversationRowView.tsx", ⏎     "packages/ui/src/v4/composer/V4ComposerToolbar.tsx", ⏎     "packages/ui/src/v4/conversationTurnRenderUnitTypes.ts", ⏎     "packages/ui/src/v4/conversationTurnWorkSegments.ts", ⏎ ] ⏎  ⏎ for path in clean_files_2: ⏎     print("=================================================================") ⏎     print(f"CLEAN_3WAY FILE: {path}") ⏎     print("--- OURS (3c5b2276..damian) ---") ⏎     print(subprocess.check_output(["git", "diff", "-U3", f"{base}..{ours}", "--", path], text=True)) ⏎     print("--- THEIRS (3c5b2276..upstream/main) ---") ⏎     print(subprocess.check_output(["git", "diff", "-U3", f"{base}..{theirs}", "--", path], text=True)) ⏎ '`
    33	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c956cfc001T7PqvInJFmSrKt.out`
    34	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c956cfc001T7PqvInJFmSrKt.out`
    35	**`shell`** `git diff 3c5b2276..upstream/main -- architecture-policy.yaml scripts/architecture/`
    36	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c96719e001X0cqM4RI9N462E.out`
    37	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c96719e001X0cqM4RI9N462E.out`
    38	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c96719e001X0cqM4RI9N462E.out`
    39	**`read`** `scripts/architecture/upstream-admission.mjs`
    40	**`shell`** `head -n 30 scripts/architecture/upstream-snapshot.json && git show upstream/main:scripts/architecture/upstream-snapshot.json | head -n 30`
    41	**`read`** `scripts/architecture/upstream-snapshot.mjs`
    42	**`shell`** `python3 -c ' ⏎ import subprocess, json ⏎  ⏎ snap = json.loads(subprocess.check_output(["git", "show", "upstream/main:scripts/architecture/upstream-snapshot.json"], text=True)) ⏎ introduced = set(snap.get("introduced", [])) ⏎ ours = subprocess.check_output(["git", "diff", "--name-status", "3c5b2276..damian"], text=True).strip().splitlines() ⏎  ⏎ print("--- Fork files that are in upstream-snapshot.json introduced[] ---") ⏎ for line in ours: ⏎     st, path = line.split("\t", 1) ⏎     if path in introduced: ⏎         print(f"  [{st}] {path}") ⏎  ⏎ print("--- Fork files that are Added [A] ---") ⏎ for line in ours: ⏎     st, path = line.split("\t", 1) ⏎     if st == "A": ⏎         print(f"  [{st}] {path}") ⏎ '`
    43	**`shell`** `git diff 3c5b2276..damian -- architecture-policy.yaml`
    44	**`shell`** `node scripts/architecture/architecture-check.mjs check --base 3c5b2276`
    45	**`shell`** `node scripts/architecture/architecture-check.mjs check --changed --base 3c5b2276`
    46	**`read`** `architecture-policy.yaml`
    47	**`read`** `scripts/architecture/index.mjs`
    48	**`shell`** `python3 -c ' ⏎ import subprocess ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎  ⏎ only_ours_m = [ ⏎     ".gitignore", ⏎     "apps/zcode-cli/packages/adapters/src/model/empty-completion-retry.ts", ⏎     "apps/zcode-cli/packages/adapters/src/model/retry-policy.ts", ⏎     "apps/zcode-cli/packages/adapters/src/model/runner-debug.ts", ⏎     "apps/zcode-cli/packages/adapters/src/skills/index.ts", ⏎     "apps/zcode-cli/packages/i18n/src/locales/en-US.ts", ⏎     "apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts", ⏎     "apps/zcode-cli/packages/i18n/src/types.ts", ⏎     "apps/zcode-cli/packages/tui/src/app-network-events.ts", ⏎     "apps/zcode-cli/vitest.config.ts", ⏎     "packages/desktop/src/main/desktopRuntimeEnv.ts", ⏎     "packages/services/src/bots/bots.ts", ⏎     "packages/services/src/bots/botsService.ts", ⏎     "packages/services/src/commands/commandFileParser.ts", ⏎     "packages/services/src/highspeed/highspeedCardService.ts", ⏎     "packages/services/src/highspeed/highspeedHttpTransport.ts", ⏎     "packages/services/src/session/zcodeTaskService.ts", ⏎     "packages/services/src/zcode-agent/zcodeStdioTransport.ts", ⏎     "packages/shared/src/bots.ts", ⏎     "packages/shared/src/command-types.ts", ⏎     "packages/shared/src/zcode-api-retry-status.ts", ⏎     "packages/shared/src/zcode-task-types-core.ts", ⏎     "packages/ui/src/ToolCallBlocks/ToolLayout.tsx", ⏎     "packages/ui/src/lib/userActionTraceCatalog.ts", ⏎     "packages/ui/src/plugin-ui/adapters/useUiPluginRecommendations.ts", ⏎     "packages/ui/src/settingsPageHelpers.tsx", ⏎     "packages/ui/src/v4/ConversationFileSummaryPanel.tsx", ⏎     "packages/ui/src/v4/ConversationStatusPanel.tsx", ⏎     "packages/ui/src/v4/conversationRowContext.ts", ⏎ ] ⏎  ⏎ for path in only_ours_m: ⏎     print("=================================================================") ⏎     print(f"ONLY_OURS [M / -]: {path}") ⏎     print(subprocess.check_output(["git", "diff", "-U2", f"{base}..{ours}", "--", path], text=True)) ⏎ '`
    49	**`shell`** `git diff 3c5b2276..upstream/main -- packages/ui/src/plugin-ui/`
    50	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c9bab33001lqvEmigrcfHHV0.out`
    51	**`shell`** `python3 -c ' ⏎ import subprocess ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎  ⏎ md_files = [ ⏎     "packages/desktop/test/desktopRuntimeEnv.test.ts", ⏎     "packages/services/test/highspeedCardService.test.ts", ⏎     "packages/services/test/zcodeStdioTransport.test.ts", ⏎     "packages/shared/test/appSettings.test.ts", ⏎     "packages/ui/test/useUiPluginRecommendations.test.ts", ⏎     "packages/ui/test/v4ConversationStatusPanelGitReview.test.ts", ⏎     "packages/ui/test/v4ConversationTurnRenderUnits.test.ts", ⏎ ] ⏎  ⏎ for path in md_files: ⏎     print("=================================================================") ⏎     print(f"SPECIAL [M / D]: {path}") ⏎     print(subprocess.check_output(["git", "diff", "-U2", f"{base}..{ours}", "--", path], text=True)) ⏎ '`
    52	**`shell`** `python3 -c ' ⏎ import subprocess, re, os ⏎  ⏎ ours_tests = [ ⏎     "packages/desktop/test/desktopRuntimeEnv.test.ts", ⏎     "packages/services/test/highspeedCardService.test.ts", ⏎     "packages/services/test/zcodeStdioTransport.test.ts", ⏎     "packages/shared/test/appSettings.test.ts", ⏎     "packages/ui/test/useUiPluginRecommendations.test.ts", ⏎     "packages/ui/test/v4ConversationStatusPanelGitReview.test.ts", ⏎     "packages/ui/test/v4ConversationTurnRenderUnits.test.ts", ⏎     "packages/services/test/daemonChannel.test.ts", ⏎     "packages/services/test/forkModelRetrySpawnEnv.test.ts", ⏎     "packages/services/test/subagentLaunchAck.test.ts", ⏎     "packages/shared/test/zcodeApiRetryStatus.test.ts", ⏎     "packages/shared/test/zcodeSessionEventTolerance.test.ts", ⏎     "packages/ui/test/chatApiRetryCountdown.test.ts", ⏎     "packages/ui/test/conversationExpandDefaultStore.test.ts", ⏎     "packages/ui/test/forkCommandModel.test.ts", ⏎     "packages/ui/test/reasoningExpandDefault.test.ts", ⏎     "packages/ui/test/toolLayoutDefaultOpen.test.ts", ⏎ ] ⏎  ⏎ upstream_files = set(subprocess.check_output(["git", "ls-tree", "-r", "--name-only", "upstream/main"], text=True).splitlines()) ⏎  ⏎ for t in ours_tests: ⏎     src = subprocess.check_output(["git", "show", f"damian:{t}"], text=True) ⏎     specs = re.findall(r"from\s+[\"'\'']([^\"'\'']+)[\"'\'']|import\(\s*[\"'\'']([^\"'\'']+)[\"'\'']\s*\)", src) ⏎     specs = [a or b for a, b in specs] ⏎     print(f"TEST: {t}") ⏎     for s in specs: ⏎         if s.startswith(".") or s.startswith("@/"): ⏎             if s.startswith("@/"): ⏎                 base_candidate = "packages/ui/src/" + s[2:] ⏎             else: ⏎                 base_candidate = os.path.normpath(os.path.join(os.path.dirname(t), s)) ⏎             stem = re.sub(r"\.(js|mjs|cjs|ts|tsx)$", "", base_candidate) ⏎             found = any(stem + ext in upstream_files for ext in [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"]) ⏎             if not found: ⏎                 print(f"  MISSING IN UPSTREAM: {s} -> {stem}.*") ⏎ '`
    53	**`shell`** `python3 -c ' ⏎ import subprocess, re, os ⏎  ⏎ ours_changed = subprocess.check_output(["git", "diff", "--name-only", "3c5b2276..damian"], text=True).splitlines() ⏎ upstream_files = set(subprocess.check_output(["git", "ls-tree", "-r", "--name-only", "upstream/main"], text=True).splitlines()) ⏎ ours_files = set(subprocess.check_output(["git", "ls-tree", "-r", "--name-only", "damian"], text=True).splitlines()) ⏎ deleted_in_upstream = set(subprocess.check_output(["git", "diff", "--diff-filter=D", "--name-only", "3c5b2276..upstream/main"], text=True).splitlines()) ⏎  ⏎ queue = list(ours_changed) ⏎ visited = set() ⏎  ⏎ while queue: ⏎     f = queue.pop(0) ⏎     if f in visited or not f.endswith((".ts", ".tsx", ".mjs", ".js")): ⏎         continue ⏎     visited.add(f) ⏎     try: ⏎         src = subprocess.check_output(["git", "show", f"damian:{f}"], text=True) ⏎     except Exception: ⏎         continue ⏎     specs = re.findall(r"from\s+[\"'\'']([^\"'\'']+)[\"'\'']|import\(\s*[\"'\'']([^\"'\'']+)[\"'\'']\s*\)", src) ⏎     specs = [a or b for a, b in specs] ⏎     for s in specs: ⏎         base_candidate = None ⏎         if s.startswith("@/"): ⏎             base_candidate = "packages/ui/src/" + s[2:] ⏎         elif s.startswith("#src/"): ⏎             pkg_root = "/".join(f.split("/")[:2]) ⏎             base_candidate = pkg_root + "/src/" + s[5:] ⏎         elif s.startswith("."): ⏎             base_candidate = os.path.normpath(os.path.join(os.path.dirname(f), s)) ⏎         if base_candidate: ⏎             stem = re.sub(r"\.(js|mjs|cjs|ts|tsx)$", "", base_candidate) ⏎             for ext in [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"]: ⏎                 cand = stem + ext ⏎                 if cand in deleted_in_upstream: ⏎                     print(f"DELETED DEPENDENCY: {f} -> {cand}") ⏎                     queue.append(cand) ⏎ '`
    54	**`shell`** `git diff 3c5b2276..upstream/main -- vitest.config.ts 'packages/*/vitest.config.ts' 'packages/*/package.json'`
    55	**`shell`** `git show upstream/main:pnpm-lock.yaml | grep -E "testing-library/(react|dom)" | head -n 10`
    56	**`shell`** `git grep -E "@testing-library/react|react-dom" -- 'packages/*/test/*.test.ts'`
    57	**`shell`** `git grep -E "@testing-library/react|react-dom" -- packages/ui/test/chatApiRetryCountdown.test.ts packages/ui/test/conversationExpandDefaultStore.test.ts packages/ui/test/forkCommandModel.test.ts packages/ui/test/reasoningExpandDefault.test.ts packages/ui/test/toolLayoutDefaultOpen.test.ts packages/ui/test/useUiPluginRecommendations.test.ts packages/ui/test/v4ConversationStatusPanelGitReview.test.ts packages/ui/test/v4ConversationTurnRenderUnits.test.ts`
    58	**`shell`** `git show upstream/main:vitest.setup.ts`
    59	**`shell`** `git diff 3c5b2276..upstream/main -- '**/tsconfig*.json'`
    60	**`shell`** `git show upstream/main:packages/ui/tsconfig.json && git show upstream/main:packages/services/tsconfig.json && git show upstream/main:packages/shared/tsconfig.json && git show upstream/main:packages/desktop/tsconfig.e2e.json`
    61	**`shell`** `git show upstream/main:packages/shared/tsconfig.testing.json`

---

## Decision record — Grupo 2 test doctrine

**2026-11-02: Opción A1 confirmed by the owner.**

When the merge executes:
- Keep all **17 fork test files** + `packages/services/test/botsService.fixtures.ts` (required by `daemonChannel.test.ts`).
- Accept upstream's retirement of the ~1.800 retired App tests; `vitest.config.ts` and `scripts/engineering-test-files.json` stay **100% identical to upstream**.
- Create `vitest.fork.config.ts` covering exactly the fork's tests; point `scripts/sync-upstream.nu` (line 42) at it.
- Migrate the 5 DOM tests (`chatApiRetryCountdown`, `reasoningExpandDefault`, `toolLayoutDefaultOpen`, `useUiPluginRecommendations`, `v4ConversationStatusPanelGitReview`) from `@testing-library/react` to a local `createRoot` (react-dom/client) + `act` helper on jsdom — `packages/ui/package.json` and `pnpm-lock.yaml` stay upstream-identical, zero lockfile conflicts in future syncs.
