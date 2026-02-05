# CHANGELOG — XPwner WebSocket

## v2.5.0 — 2026-02-05

### xWarmer — Handler job-based

#### 🆕 `src/handlers/warmer.js`
- `handleRequestWarmerJob`: Worker solicita job disponible de `xwarmer_actions`
- `handleWarmerNext`: Asigna siguiente cuenta del deck + nick/tweet random del grupo
- `handleWarmerResult`: Registra resultado en `xwarmer_action_log`, actualiza contadores y salud de cuenta
- Notificación Telegram al completar job

#### 🔄 Cambios en `app.js`
- Registrados 3 nuevos message types: `request_warmer_job`, `warmer_next`, `warmer_result`

#### 🧹 Limpieza legacy
- `actions.js`: Eliminada toda lógica `isWarmer` (ya no usa tabla vieja)
- `status.js`: Eliminada `updateWarmerAccountHealth` (ahora en warmer.js)
- `auth.js`: Cleanup de warmer adaptado a nueva estructura de jobs
- `disconnect.js`: Cleanup de warmer adaptado a nueva estructura de jobs

## v2.4.0 — 2026-02-03

### Tweet Snapshot Storage

#### 📸 `handleTweetSnapshot()` en `status.js`
- Nuevo handler para mensaje `tweet_snapshot` del Worker
- Recibe JSON con datos del tweet (texto, autor, métricas, media) al completar acción
- Guarda en columna `actions.tweet_snapshot` (JSON)
- Valida que el Worker tiene asignada la acción antes de guardar
- Solo acciones xPwner (no warmer) — por diseño del Worker

#### 🔌 `app.js`
- Nueva ruta de mensaje `tweet_snapshot` desde monitors
- Importa `handleTweetSnapshot` desde status handler

### Retención token_actions_log ampliada
- `cleanupOldLogs()` cambiado de 7 días a 60 días de retención

---

## v2.3.0 — 2026-02-01

### Token Batch API — Request/Report N tokens en 1 mensaje

#### 📦 Batch handlers (`src/handlers/tokenManager.js`)
- **`handleRequestTokenBatch`** — Worker solicita N tokens de golpe → WebSocket asigna con `FOR UPDATE SKIP LOCKED LIMIT N`
- **`handleTokenReportBatch`** — Worker reporta array de resultados en 1 solo mensaje
- Reduce overhead de WebSocket dramáticamente para views paralelos
- Misma lógica de salud de tokens (deslogueado, suspendido, rate_limited) que el flujo individual

---

## v2.2.0 — 2026-02-01

### xWarmer → xchecker_accounts health tracking

#### 🔄 src/handlers/actions.js
- Query de xwarmer ahora incluye `account_id` desde `xwarmer_actions`
- Payload al Worker incluye `account_id` para tracking

#### 🩺 src/handlers/status.js
- Nueva función `updateWarmerAccountHealth()` — actualiza `xchecker_accounts` al completar/fallar acciones warmer:
  - **Completado**: `ultimo_warmeo = NOW()`, reset `fails_consecutivos`, `estado_salud = 'activo'`
  - **Error**: analiza error (deslogueado/suspendido/rate_limited), incrementa `fails_consecutivos`, guarda `ultimo_error`
  - Misma lógica de análisis que Token Manager v2 para consistencia
- Se ejecuta automáticamente al recibir status de cualquier acción `xwarmer_*`

---

## v2.1.0 — 2026-02-01

### Token Management v2 — Gestión Inteligente de Tokens

#### 🔌 Nuevos handlers
- **`src/handlers/tokenManager.js`** — Módulo completo de gestión de tokens:
  - `handleRequestToken`: Worker solicita token → WebSocket asigna inteligentemente
    - Selecciona token activo, menos usado (ultimo_uso ASC), que no haya hecho la acción para ese tweet
    - `FOR UPDATE SKIP LOCKED` para concurrencia entre múltiples workers
    - Bloquea token (locked=1) al asignar, desbloquea al recibir reporte
  - `handleTokenReport`: Worker reporta resultado → WebSocket actualiza DB
    - Inserta en `token_actions_log` (tracking de acciones)
    - Actualiza `estado_salud` según error (deslogueado, suspendido, rate_limited, muerto)
    - Actualiza cookies (`ct0`, `auth_token`, `cookies_full`) si vienen en `set_cookies`
    - Desbloquea token automáticamente
  - `cleanupStaleLocks`: Desbloquea tokens bloqueados >10 min (cada 2 min)
  - `cleanupOldLogs`: Elimina logs >7 días de `token_actions_log` (cada hora)

#### 🔄 Cambios en handlers existentes
- **`src/handlers/actions.js`**: 
  - Agrega `preconfig_id` y `use_token_manager: true` al payload de acción
  - xWarmer sigue con su propio sistema (use_token_manager: false)

#### 📡 Nuevos mensajes WebSocket
- `request_token` → Worker pide un token (deck_id, action_type, tweet_id)
- `token_assigned` ← WebSocket responde con token (token_id, nick, auth_token, ct0, cookies_full)
- `no_token_available` ← WebSocket responde si no hay tokens disponibles
- `token_report` → Worker reporta resultado (token_id, success, error_code, set_cookies)

#### 🔧 app.js
- Registra nuevos handlers en el router de mensajes
- Inicia intervalos de cleanup automático
- Bumped a v2.1

## v2.01 — 2026-02-01

### Fix: preservar URLs acumuladas en crash/restart
- **`src/handlers/status.js`** — `handleStatus` ahora verifica si el comentario previo contiene URLs
- Si la acción vuelve a "En Cola" (timeout/crash), preserva las URLs existentes
- Solo sobreescribe si el comentario anterior no contiene links `https://`
- Complementa el fix del Worker (`comentarioThread.js`) para que las URLs de comentarios sobrevivan reinicios completos

---

## v2.00 — 2026-01-31

### Modularización completa
- **`app.js`** — Reducido de 447 a ~100 líneas (router limpio)
- **`src/db.js`** — Pool MySQL centralizado con `connectionLimit=20`
- **`src/state.js`** — Maps de monitors/panels + helpers `broadcastToPanels()` / `broadcastToMonitors()`
- **`src/handlers/auth.js`** — Autenticación extraída
- **`src/handlers/actions.js`** — `request_action`, `task_accepted`, `task_rejected`, `new_action`
- **`src/handlers/status.js`** — Status, progreso, `token_fail`, `token_success`
- **`src/handlers/monitor.js`** — CPU/RAM updates y logs
- **`src/handlers/telegram.js`** — Notificaciones Telegram extraídas
- **`src/handlers/disconnect.js`** — Cleanup al desconectar

### Push instantáneo (Panel → Worker)
- **Nuevo mensaje `new_action`** — Panel notifica nueva acción por WebSocket
- **Broadcast `action_available`** — Servidor avisa a Workers conectados
- **Latencia reducida** — De ~10s (polling) a <100ms
- **Fallback** — Polling de 10s se mantiene para acciones creadas por cron/API

### Token Health System
- **`token_fail` / `token_success`** — Workers reportan salud de tokens
- **Auto-clasificación** — activo (0-4 fallos), enfermo (5-9), muerto (10+)
- **Tabla `token_health`** — Tracking persistente por cuenta/token
- **Tabla `action_log`** — Trazabilidad completa de acciones

### Compatibilidad PM2
- **`dotenv`** — Usa `path.join(__dirname, '.env')` en vez de path hardcodeado
- **Multi-servidor** — Funciona en xpwner e impulsaredes sin cambiar código

---

## v1.00 — Release inicial

### Servidor WebSocket
- **Autenticación** — Por token de cuenta (SuperAdministrador)
- **Multi-worker** — Múltiples Workers por cuenta con UUID (`worker_id`)
- **Multi-panel** — Múltiples paneles por cuenta
- **Pull-based** — Workers solicitan acciones con `request_action`

### Asignación de acciones
- **Transacciones atómicas** — `SELECT ... FOR UPDATE` para evitar race conditions
- **Worker isolation** — Solo el Worker asignado puede actualizar una acción
- **Task accept/reject** — Worker confirma o rechaza la acción recibida
- **Soporte acciones** — Retweet, Favoritos, Comentario, Reportar, Bookmark, View

### XWarmer
- **Acciones XWarmer** — `xwarmer_retweet`, `xwarmer_favoritos`
- **Tabla separada** — `xwarmer_actions` con campos específicos (token, ct0, nick_target)
- **Detección automática** — Prefijo `xwarmer_` en el tipo de acción

### Monitoreo
- **CPU/RAM** — Worker envía métricas, servidor las persiste y reenvía a paneles
- **Estado de conexión** — `Conectado` / `Desconectado` / `Error` en DB

### Logs y status
- **Logs persistentes** — Se guardan en tabla `log`
- **Status de acciones** — Actualización en DB con verificación de `worker_id`
- **Progreso** — Incremento atómico de `acciones_realizadas`

### Notificaciones
- **Telegram** — Mensaje automático al completar acciones (solo acciones normales, no XWarmer)
- **Formato MarkdownV2** — Con emojis por tipo de acción

### Recuperación
- **Desconexión de Worker** — Acciones pendientes vuelven a "En Cola" con `worker_id = NULL`
- **Reconexión** — Flag `reconnect` para no resetear acciones en estado "Desconeccion"
- **Notificación a paneles** — Aviso de desconexión del monitor
