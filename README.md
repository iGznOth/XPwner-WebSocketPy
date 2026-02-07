# 🔌 XPwner WebSocket

<p align="center">
  <b>Servidor WebSocket que conecta el Panel con los Workers</b>
  <br/>
  <sub>Node.js · WebSocket (ws) · MySQL2 · Telegram Notifications</sub>
</p>

---

## 🚀 Características

### Core
- **Hub central** — Conecta Panel(es) y Worker(s) en tiempo real
- **Push instantáneo** — Panel notifica nuevas acciones, Workers las reciben en <100ms
- **Multi-worker** — Múltiples Workers por cuenta con asignación por `worker_id`
- **Race-condition safe** — Transacciones MySQL con `FOR UPDATE` para asignación atómica
- **Auto-recovery** — Limpia acciones pendientes al desconectarse un Worker
- **Ping/pong heartbeat** — Detecta workers muertos cada 30s

### Acciones
- **Soporte completo** — Retweet, Like, Comentario, Quote, Reportar, Bookmark, View, Poll
- **Tweet Snapshot** — Almacena captura del tweet al completar acción
- **Stop actions** — Cancelación de acciones en ejecución bajo demanda

### Browser Jobs
- **Unlock** — Desbloqueo de cuentas via Camoufox + YesCaptcha
- **Login** — Login de cuentas via Chrome (nodriver)
- **Dead state** — Marca cuentas irrecuperables
- **Appeals status** — Detecta cuentas permanentemente bloqueadas
- **cookies_full** — Guarda cookies completas en unlock/login exitoso

### Módulos
- **XWarmer** — Soporte para acciones de calentamiento de cuentas
- **XSpammer** — Módulo separado con polling independiente y APM configurable
- **XChecker** — Health checks y scraping de perfiles

### Real-time Updates
- **action_update** — Broadcast a panels cuando una acción empieza
- **xchecker_update** — Updates de cuentas en tiempo real
- **xchecker_job_progress** — Progreso de jobs de scraping
- **Monitoreo** — CPU/RAM del Worker en tiempo real hacia el Panel

### Notificaciones
- **Telegram** — Notificaciones automáticas al completar acciones

---

## 📋 Requisitos

- Node.js 18+
- MySQL 5.7+ / MariaDB 10.3+
- PM2 (recomendado para producción)

---

## ⚙️ Instalación

```bash
npm install
cp .env.example .env
# Editar .env con credenciales
```

---

## 🚀 Ejecutar

```bash
# Desarrollo
node index.js

# Producción (PM2)
pm2 start index.js --name xpwner-ws
```

---

## 📁 Estructura

```
XPwner-WebSocketPy/
├── src/
│   ├── handlers/       # Handlers por tipo de mensaje
│   │   ├── actions.js  # Acciones normales
│   │   ├── browser.js  # Unlock/Login
│   │   ├── scraping.js # Health checks
│   │   ├── warmer.js   # XWarmer
│   │   └── xspammer.js # XSpammer
│   ├── db.js           # Pool MySQL
│   └── telegram.js     # Notificaciones
├── index.js            # Entry point
└── .env                # Configuración
```

---

## 📄 Licencia

Propietario — Todos los derechos reservados.
