# 🔌 XPwner WebSocket

<p align="center">
  <b>Servidor WebSocket que conecta el Panel con los Workers</b>
  <br/>
  <sub>Node.js · WebSocket (ws) · MySQL2 · Telegram Notifications</sub>
</p>

---

## 🚀 Características

- **Hub central** — Conecta Panel(es) y Worker(s) en tiempo real  
- **Soporte acciones** — Retweet, Favoritos, Comentario, Quote, Reportar, Bookmark, View, Poll
- **Tweet Snapshot** — Almacena captura del tweet al completar acción (JSON en DB)
- **Push instantáneo** — Panel notifica nuevas acciones, Workers las reciben en <100ms
- **Real-time panels** — Broadcast de updates a panels (action_update, xchecker_update, progress)
- **Stop actions** — Cancelación de acciones en ejecución bajo demanda
- **Multi-worker** — Múltiples Workers por cuenta con asignación por `worker_id`
- **Race-condition safe** — Transacciones MySQL con `FOR UPDATE` para asignación atómica
- **Token Health** — Tracking automático de salud de tokens (activo/enfermo/muerto)
- **XWarmer** — Soporte para acciones de calentamiento de cuentas
- **XSpammer** — Módulo separado con polling independiente y APM configurable
- **Telegram** — Notificaciones automáticas al completar acciones
- **Auto-recovery** — Limpia acciones pendientes al desconectarse un Worker
- **Monitoreo** — CPU/RAM del Worker en tiempo real hacia el Panel
- **Modular** — Código organizado en handlers independientes

---

## 📡 Arquitectura

```
┌──────────┐          ┌──────────────────┐          ┌──────────┐
│  Panel   │◄── WS ──►│   WebSocket      │◄── WS ──►│  Worker  │
│  (PHP)   │          │   Server         │          │ (Node.js)│
└──────────┘          │   (este repo)    │          └──────────┘
                      └────────┬─────────┘
                               │
                          ┌────▼────┐
                          │  MySQL  │
                          │   (DB)  │
                          └─────────┘
```

---

## 📦 Estructura

```
XPwner-WebSocket/
├── app.js                      # Router principal (~100 líneas)
├── src/
│   ├── db.js                   # Pool MySQL (connectionLimit=20)
│   ├── state.js                # Maps monitors/panels + broadcast helpers
│   └── handlers/
│       ├── auth.js             # Autenticación
│       ├── actions.js          # request_action, accept, reject, new_action
│       ├── status.js           # Status, progreso, token health, warmer health
│       ├── tokenManager.js    # Token Manager v2: assign, report, batch, cleanup
│       ├── monitor.js          # CPU/RAM, logs
│       ├── telegram.js         # Notificaciones Telegram
│       └── disconnect.js       # Cleanup al desconectar
├── migrations/
│   └── 001_token_health.sql    # Tablas token_health + action_log
├── .env.example                # Template de configuración
└── package.json
```

---

## 🔄 Flujo de mensajes

### Panel → Server
| Tipo | Descripción |
|------|-------------|
| `auth` | Autenticación: `{ token, client_type: "panel" }` |
| `new_action` | Nueva acción creada: `{ tipo }` → broadcast a Workers |

### Worker → Server
| Tipo | Descripción |
|------|-------------|
| `auth` | Autenticación: `{ token, reconnect }` |
| `request_action` | Solicita acción: `{ tipo }` |
| `task_accepted` | Acepta acción asignada |
| `task_rejected` | Rechaza acción (devuelve a cola) |
| `status` | Status final: Completado/Error |
| `progreso` | Progreso incremental |
| `update` | Métricas CPU/RAM |
| `log` | Log del worker |
| `token_fail` | Reporta fallo de token (legacy) |
| `token_success` | Reporta éxito de token (legacy) |
| `request_token` | Token Manager v2: solicita 1 token |
| `token_report` | Token Manager v2: reporta resultado |
| `request_token_batch` | Token Manager v2: solicita N tokens |
| `token_report_batch` | Token Manager v2: reporta N resultados |

### Server → Worker
| Tipo | Descripción |
|------|-------------|
| `action` | Acción asignada con datos completos |
| `action_available` | Notifica nueva acción disponible (push) |
| `no_action` | No hay acciones disponibles |
| `token_assigned` | Token Manager v2: token asignado |
| `no_token_available` | Token Manager v2: no hay tokens |
| `token_batch_assigned` | Token Manager v2: batch de tokens asignados |
| `command` | Comando (pause/resume) |

### Server → Panel
| Tipo | Descripción |
|------|-------------|
| `usage` | Métricas CPU/RAM del worker |
| `disconnect` | Worker desconectado |

---

## ⚡ Push instantáneo

```
Panel crea acción → INSERT MySQL → JS envía "new_action" por WS
→ Server broadcast "action_available" a Workers de esa cuenta
→ Worker con capacidad pide "request_action" inmediatamente
→ Server asigna y envía acción
Latencia: <100ms (antes: hasta 10s por polling)
```

El polling de 10s se mantiene como **fallback** para acciones creadas por cron (XWarmer) o API.

---

## 🏥 Token Health

Workers reportan éxito/fallo de cada token. El servidor trackea automáticamente:

| Estado | Fallos consecutivos | Acción |
|--------|:-------------------:|--------|
| **activo** | 0-4 | Se usa normalmente |
| **enfermo** | 5-9 | Warning — posible baneo |
| **muerto** | 10+ | Token inutilizable |

Un éxito resetea el contador a 0. Vista en Panel: `/token-health`.

---

## ⚙️ Configuración

```bash
cp .env.example .env
```

| Variable | Descripción |
|----------|-------------|
| `DB_HOST` | Host de MySQL |
| `DB_USER` | Usuario de MySQL |
| `DB_PASSWORD` | Contraseña de MySQL |
| `DB_DATABASE` | Nombre de la base de datos |
| `WS_PORT` | Puerto del servidor WebSocket |
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram |

---

## 🏗️ Instalación

```bash
npm install
cp .env.example .env  # Configurar
npm start             # o pm2 start app.js
```

### Migración DB (primera vez)
```bash
mysql -u user -p database < migrations/001_token_health.sql
```

---

## 📊 Tablas MySQL

| Tabla | Uso |
|-------|-----|
| `cuentas` | Usuarios, tokens de auth, estado del monitor |
| `actions` | Cola de acciones generales |
| `xwarmer_actions` | Cola de acciones XWarmer |
| `preconfigs` | Configuraciones de proxy/tokens por cuenta |
| `monitors` | Métricas CPU/RAM |
| `log` | Logs del sistema |
| `token_health` | Salud de tokens (fallos, estado) |
| `action_log` | Trazabilidad de acciones |

---

<p align="center">
  <sub>XPwner WebSocket v2.7 · El cerebro que conecta todo 🔌</sub>
</p>
