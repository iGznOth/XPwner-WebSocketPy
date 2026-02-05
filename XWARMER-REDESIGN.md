# xWarmer Rediseño — Planificación v4 (FINAL)

> ⚠️ SOLO PLANIFICACIÓN. No se ejecuta nada hasta aprobación explícita.

---

## Objetivo

TODAS las cuentas de un deck realizan acciones configuradas sobre nicks/tweets random en ciclos programados. El worker recibe el job completo, pide token + destino uno por uno al WebSocket, y reporta resultado de cada uno.

---

## Decisiones confirmadas ✅

1. **1 job por tipo de acción por ciclo.** `retweets_count=3` → 3 jobs RT. `likes_count=2` → 2 jobs FAV.
2. **Flujo cron → job → worker → websocket loop** ✅
3. **Panel elige nick random + tweet random POR CADA cuenta** cuando el worker pide ✅
4. **Worker reporta resultado por cuenta** ✅
5. **Progreso real: cuentas_ejecutadas / total_cuentas** ✅
6. **Log individual en `xwarmer_action_log`** ✅
7. **Datos viejos de `xwarmer_actions` se pueden perder** (estamos en dev) ✅
8. **Solo RT/FAV por ahora**, pero dejamos preparado para más tipos ✅
9. **Paralelismo configurable desde panel** ✅

---

## Análisis del WebSocket actual

### Lo que ya existe para warmer

El WebSocket YA tiene soporte parcial de xWarmer:

**`actions.js`** — Worker pide acciones con `tipo: 'xwarmer_retweet'` / `'xwarmer_favoritos'`:
- Detecta `isWarmer` → query a `xwarmer_actions` en vez de `actions`
- Envía token+ct0 pre-asignado (de la fila)
- `use_token_manager = false`

**`status.js`** — Reporta resultado:
- Detecta `isWarmer` → UPDATE en `xwarmer_actions`
- `updateWarmerAccountHealth()` → actualiza `xchecker_accounts` (ultimo_warmeo, estado_salud, fails)

**`auth.js` / `disconnect.js`** — Limpieza:
- Al reconectar: acciones warmer en "Desconeccion" → "En Cola"
- Al desconectar: acciones warmer en proceso → "En Cola"

### Token Manager (existe, reutilizable)

`tokenManager.js` tiene lógica probada para:
- Selección de token: activo, sano, no bloqueado, menos usado primero
- Locking con `FOR UPDATE SKIP LOCKED`
- Reporte de éxito/fallo con actualización de salud
- Batch requests (request_token_batch)
- Limpieza de locks expirados

### Lo que necesita cambiar

El sistema actual es **1 fila = 1 cuenta con token pre-asignado**. El nuevo es **1 fila = 1 job completo, el WebSocket resuelve token + destino en cada iteración**.

Se necesita un **nuevo handler `warmer.js`** que combine:
- Lógica de Token Manager (selección de cuenta del deck)
- Selección de nick/tweet random de `xwarmer_nicks`
- Progreso del job
- Log de resultados

---

## Tablas

### `xwarmer_actions` (reestructurada — 1 fila = 1 job)

```sql
DROP TABLE IF EXISTS xwarmer_actions;

CREATE TABLE xwarmer_actions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  module_id INT NOT NULL,
  preconfig_id INT NOT NULL,
  grupo_nicks VARCHAR(255) NOT NULL,
  tipo VARCHAR(50) NOT NULL,            -- 'retweet', 'favoritos' (extensible)
  
  -- Progreso
  total_cuentas INT NOT NULL,
  cuentas_ejecutadas INT DEFAULT 0,
  cuentas_exitosas INT DEFAULT 0,
  cuentas_error INT DEFAULT 0,
  
  -- Estado
  estado ENUM('En Cola','En Proceso','Completado','Error','Pausado') DEFAULT 'En Cola',
  
  -- Config de ejecución
  request TINYINT DEFAULT 2,            -- 0=nav, 1=request, 2=ambos
  apm INT DEFAULT 60,
  threads INT DEFAULT 1,                -- paralelismo configurable
  
  -- Worker
  worker_id VARCHAR(36) DEFAULT NULL,
  
  -- Notificación
  chat_id VARCHAR(255) DEFAULT NULL,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  
  FOREIGN KEY (module_id) REFERENCES xwarmer_modules(id) ON DELETE CASCADE,
  FOREIGN KEY (preconfig_id) REFERENCES preconfigs(id) ON DELETE CASCADE,
  KEY idx_estado (estado),
  KEY idx_module (module_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### `xwarmer_action_log` (nueva — resultado por cuenta)

```sql
CREATE TABLE xwarmer_action_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  job_id INT NOT NULL,
  account_id INT NOT NULL,
  nick_target VARCHAR(255) NOT NULL,
  url TEXT NOT NULL,
  
  -- Resultado
  estado ENUM('Completado','Error') NOT NULL,
  error_msg TEXT DEFAULT NULL,
  error_code VARCHAR(50) DEFAULT NULL,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (job_id) REFERENCES xwarmer_actions(id) ON DELETE CASCADE,
  KEY idx_job (job_id),
  KEY idx_job_account (job_id, account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### `xwarmer_modules` — agregar campo `threads`

```sql
ALTER TABLE xwarmer_modules ADD COLUMN threads INT DEFAULT 1 COMMENT 'Cantidad de ejecuciones paralelas';
```

---

## Protocolo WebSocket (nuevo handler `warmer.js`)

### 1. Worker pide un warmer job

```
Worker → WS: { type: "request_warmer_job" }
```

WS busca en `xwarmer_actions WHERE estado = 'En Cola'` (ORDER BY created_at ASC, LIMIT 1 FOR UPDATE):

```
WS → Worker: {
  type: "warmer_job",
  job: {
    id: 123,
    tipo: "retweet",
    total_cuentas: 500,
    cuentas_ejecutadas: 0,
    apm: 60,
    request: 2,
    threads: 3,
    grupo_nicks: "politicos"
  }
}
```

O si no hay jobs:
```
WS → Worker: { type: "no_warmer_job" }
```

WS actualiza: `estado = 'En Proceso', worker_id = X, started_at = NOW()`

### 2. Worker pide siguiente cuenta + destino

```
Worker → WS: { type: "warmer_next", job_id: 123 }
```

WS hace:
1. Buscar siguiente cuenta del deck:
   - `xchecker_accounts WHERE deck_id = ? AND estado = 'active' AND sana`
   - `AND id NOT IN (SELECT account_id FROM xwarmer_action_log WHERE job_id = ?)`
   - `ORDER BY ultimo_warmeo ASC LIMIT 1 FOR UPDATE SKIP LOCKED`
   - Lock la cuenta (mismo patrón que Token Manager)

2. Elegir nick random:
   - `xwarmer_nicks WHERE grupo = ? AND estado = 'active' AND tweets IS NOT NULL AND tweets != '[]' ORDER BY RAND() LIMIT 1`

3. Elegir tweet random del nick (del JSON `tweets`)

```
WS → Worker: {
  type: "warmer_target",
  job_id: 123,
  account_id: 456,
  auth_token: "abc...",
  ct0: "xyz...",
  cookies_full: "...",
  proxy: "http://...",
  proxy_request: "http://...",
  nick_target: "@politico1",
  url: "https://x.com/politico1/status/12345",
  progress: {
    ejecutadas: 44,
    total: 500,
    exitosas: 42,
    errores: 2
  }
}
```

O si no quedan cuentas:
```
WS → Worker: {
  type: "warmer_done",
  job_id: 123,
  total: 500,
  exitosas: 480,
  errores: 20
}
```
WS actualiza: `estado = 'Completado', completed_at = NOW()`
WS envía notificación Telegram.

### 3. Worker reporta resultado

```
Worker → WS: {
  type: "warmer_result",
  job_id: 123,
  account_id: 456,
  nick_target: "@politico1",
  url: "https://x.com/politico1/status/12345",
  status: "ok",
  error_msg: null,
  error_code: null,
  set_cookies: "ct0=newval; auth_token=same"  // opcional, si cambió
}
```

WS hace:
1. INSERT en `xwarmer_action_log`
2. UPDATE `xwarmer_actions`: `cuentas_ejecutadas++`, `cuentas_exitosas++` o `cuentas_error++`
3. UPDATE `xchecker_accounts`: `ultimo_warmeo = NOW()`, unlock, actualizar salud
4. Si `set_cookies` → actualizar cookies en `xchecker_accounts`

```
WS → Worker: { type: "warmer_result_ack", job_id: 123, ok: true }
```

---

## Flujo completo

```
CRON (cada 5 min)
  │
  ├─ Módulo activo + día + hora coinciden
  │   ├─ $total = countDeckTokens(preconfig_id)
  │   ├─ retweets_count=3 → INSERT 3 jobs tipo='retweet' en xwarmer_actions
  │   └─ likes_count=2   → INSERT 2 jobs tipo='favoritos' en xwarmer_actions
  │
  └─ Pre-scrape: 1h antes → trigger scraping del grupo (sin cambios)

WORKER
  │
  ├─ request_warmer_job → recibe job #123 (tipo=retweet, 500 cuentas, apm=60)
  │
  └─ LOOP (respetando APM):
      ├─ warmer_next (job_id=123)
      │   └─ WS responde: cuenta #456 + @politico1 + tweet_url
      ├─ Ejecutar acción (RT a tweet_url con token de cuenta #456)
      ├─ warmer_result (job_id=123, account_id=456, status=ok)
      │   └─ WS actualiza progreso, log, salud
      └─ Repetir hasta warmer_done

PANEL (historial)
  │
  └─ Lee xwarmer_actions (jobs) → barra de progreso: 312/500 (62%)
      └─ Click → modal con xwarmer_action_log → errores, nicks, cuentas
```

---

## Ejemplo concreto

**Config módulo:**
- Deck: "MiDeck" (500 cuentas activas)
- Grupo nicks: "politicos" (20 nicks activos con tweets)
- Retweets: habilitado, count = 2
- Likes: habilitado, count = 1
- Threads: 3
- Horario: Lunes y Jueves 14:00

**Lunes 14:00 — Cron crea 3 jobs:**

| job_id | tipo | grupo_nicks | total_cuentas | threads | apm |
|--------|------|-------------|---------------|---------|-----|
| 101 | retweet | politicos | 500 | 3 | 60 |
| 102 | retweet | politicos | 500 | 3 | 60 |
| 103 | favoritos | politicos | 500 | 3 | 60 |

**Worker procesa job #101:**
- Pide `warmer_next` → recibe cuenta #1 + @politico_A + tweet_xyz → ejecuta RT → reporta ok
- Pide `warmer_next` → recibe cuenta #2 + @politico_M + tweet_abc → ejecuta RT → reporta ok
- ... (498 veces más)
- Pide `warmer_next` → recibe `warmer_done` (500/500, 480 ok, 20 error)

**Cada cuenta fue a un nick random distinto.** La distribución es natural entre los 20 nicks.

---

## Archivos a modificar

### Panel (PHP)

| Archivo | Cambio |
|---------|--------|
| **nueva migración SQL** | DROP+CREATE `xwarmer_actions`, CREATE `xwarmer_action_log`, ALTER `xwarmer_modules` ADD threads |
| `api/xwarmer_actions.php` | Simplificar: solo INSERT jobs (ya no itera cuentas ni asigna tokens) |
| `pages/xwarmer_historial.php` | Leer de nueva estructura, barra de progreso real |
| `api/xwarmer_historial_ajax.php` | Adaptar: errores de `xwarmer_action_log` |
| `pages/xwarmer.php` | Agregar columna "Threads" en tabla y en modal |
| `api/save_xwarmer.php` | Agregar campo `threads` al INSERT/UPDATE |

### WebSocket (Node.js)

| Archivo | Cambio |
|---------|--------|
| **`src/handlers/warmer.js`** (NUEVO) | Handler completo: `request_warmer_job`, `warmer_next`, `warmer_result` |
| `app.js` | Registrar nuevos message types del handler warmer |
| `src/handlers/actions.js` | Limpiar código legacy de `isWarmer` (ya no se usa) |
| `src/handlers/status.js` | Limpiar `updateWarmerAccountHealth` legacy |
| `src/handlers/auth.js` | Actualizar cleanup de warmer al reconectar |
| `src/handlers/disconnect.js` | Actualizar cleanup de warmer al desconectar |

### Worker (Python)

| Archivo | Cambio |
|---------|--------|
| **Nuevo handler warmer** | Loop: request_warmer_job → warmer_next → ejecutar → warmer_result → repeat |

### Sin cambios
- `pages/xwarmer_nick.php`
- `api/xwarmer_nick.php`
- `api/xwarmer_scraping_nicks.php`
- `api/toggle_xwarmer.php` / `api/delete_xwarmer.php`
- Tabla `actions` — NO SE TOCA
- Tabla `xwarmer_modules` — solo ADD threads
- Tabla `xwarmer_nicks` — NO SE TOCA

---

## Pendiente

- [ ] Confirmar diseño completo → proceder a implementar
