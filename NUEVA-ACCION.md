# Checklist: Agregar Nueva Acción a XPwner

> Guía paso a paso para no olvidar ningún archivo al agregar una nueva acción (tipo de engagement).
> Última actualización: 2026-02-03

## Nomenclatura

- **`{tipo}`** = nombre interno de la acción (ej: `quote`, `bookmark`, `retweet`, `favoritos`, `comentario`, `reportar`, `view`)
- **`{Tipo}`** = nombre bonito/capitalizado (ej: `Quotes`, `Bookmark`, `Favoritos`)
- **`{tipo_db}`** = valor guardado en columna `tipo` de tabla `actions` (debe coincidir exactamente con lo que el Worker pide)

---

## 1. XPwner-Panel (PHP)

### 1.1 Página de acción
- [ ] **`pages/{tipo}.php`** — Crear la página (copiar de `comentarios.php` o `bookmark.php` como base)
  - Form con URL del tweet + campos específicos de la acción
  - INSERT a tabla `actions` con `tipo = '{tipo_db}'`
  - Llamar `notifyNewAction('{tipo_db}')` después del INSERT
  - Usar `$_SESSION['rmc']` (o el request mode que corresponda) para el campo `request`
  - DataTable con `url: '/api/actions_tables?type={tipo_db}'`
  - Validación JS (campos requeridos + `is-invalid`) antes de abrir modal de confirmación

### 1.2 Sidebar
- [ ] **`resources/sidebar.json`** — Agregar entrada:
  ```json
  {
      "title": "{Tipo}",
      "url": "{tipo}",
      "icon": "<ion-icon name=\"ICONO-outline\"></ion-icon>",
      "target": "_parent",
      "hr": false,
      "permisos": "{tipo_db}",
      "range": "Operador",
      "visible": true
  }
  ```

### 1.3 Permisos de usuario
- [ ] **`pages/usuarios.php`** — Agregar al array `$permisosDisponibles`:
  ```php
  ['title' => '{Tipo}', 'value' => '{tipo_db}']
  ```

### 1.4 Acciones de deck
- [ ] **`pages/clientes.php`** — Agregar en **3 lugares**:
  1. `$acciones_posibles` (array para procesar POST)
  2. `$acciones` (array asociativo para checkboxes del form)
  3. `strtr()` (mapeo para mostrar nombre bonito en tabla de lista)

### 1.5 Costos globales
- [ ] **`resources/costosglobales.json`** — Agregar `"{tipo_db}": N` (costo en tokens)
- [ ] **`pages/costos.php`** — Agregar en **2 arrays**:
  1. `$accionesDefault` → `'{tipo_db}' => 0`
  2. `$nombresBonitos` → `'{tipo_db}' => 'Nombre Bonito'`

### 1.6 API de tablas (historial)
- [ ] **`api/actions_tables.php`** — Si la acción necesita tratamiento especial:
  - Agregar case para delete link (si no cae en el `else` genérico)
  - Agregar formato especial en `$formatted['comentario']` si aplica (ej: `<pre>` para URLs)
  - Si la acción usa `util` de forma especial (como reportar), agregar campos extra

### 1.7 Routing
- [ ] **`index.php`** — Verificar que el routing cargue `pages/{tipo}.php` (normalmente es dinámico, pero confirmar)

---

## 2. XPwner-Worker (Node.js)

### 2.1 Thread
- [ ] **`src/threads/{tipo_db}Thread.js`** — Crear el thread (copiar de `comentarioThread.js` o `bookmarkThread.js`)
  - Recibe datos vía `process.on('message')`
  - Llama a `requestBase()` o `base()` según el request mode
  - Reporta progreso, status y logs al parent
  - Manejo de Token Manager (`requestTokenFromParent` / `reportTokenToParent`)
  - `process.exit(0)` al terminar

### 2.2 Request mode (API directa)
- [ ] **`src/request/src/request.js`** — Agregar función `{tipo}Tweet()` (o nombre que corresponda)
  - La función que hace la request HTTP/GraphQL a Twitter
  - Exportarla en el module.exports
- [ ] **`src/request/base.js`** — Agregar `case '{tipo_db}':` en el switch
  - Importar la función nueva arriba
  - Llamarla con los params correctos

### 2.3 Browser mode (Puppeteer) — solo si aplica
- [ ] **`src/puppeteer/base.js`** — Agregar `case '{tipo_db}':` en el switch
- [ ] **`src/actions/{tipo_db}.js`** — Crear la acción de Puppeteer (si usa browser)

### 2.4 Registro en el sistema
- [ ] **`src/services/socket.js`** — Agregar `'{tipo_db}'` al array `ACTION_TYPES`
  - Sin esto, el Worker **nunca pide** acciones de este tipo al WebSocket
- [ ] **`src/config.js`** — Agregar en `maxThreads`:
  ```js
  "{tipo_db}": process.env.{TIPO}LIMIT || 1,
  ```
  - Sin esto, el capacity check falla y las acciones se rechazan

---

## 3. XPwner-Websocket (Node.js)

> El WebSocket maneja acciones de forma **genérica** (query por `tipo` en la DB).
> Normalmente **NO necesita cambios**, pero verificar:

- [ ] **`src/handlers/actions.js`** — `handleRequestAction()` usa `data.tipo` directo en SQL → OK genérico
- [ ] **`src/handlers/tokenManager.js`** — Token Manager es genérico por `action_type` → OK
- [ ] Si la acción necesita lógica especial de asignación/notificación, agregar aquí

---

## 4. Base de Datos

> La tabla `actions` es genérica, normalmente no se necesitan cambios de schema.

- [ ] Verificar que `actions.tipo` acepte el nuevo valor (columna VARCHAR, no ENUM)
- [ ] Si la acción usa campos especiales, verificar que `actions.util` o `actions.media` cubran el caso

---

## 5. Documentación y Changelog

- [ ] **Panel CHANGELOG** — Nueva versión con descripción de la acción
- [ ] **Worker CHANGELOG** — Nueva versión
- [ ] **Panel README** — Actualizar lista de acciones
- [ ] **Worker README** — Actualizar lista de acciones y estructura de archivos
- [ ] **WebSocket README** — Mencionar en lista de acciones soportadas

---

## 6. Testing

- [ ] Crear acción desde el panel → verificar que aparece en tabla `actions` con tipo correcto
- [ ] Worker la recoge (logs del worker muestran `request_action` para el tipo)
- [ ] Se ejecuta y reporta status correcto (En Proceso → Completado)
- [ ] Permisos: usuario sin permiso no ve la página ni el sidebar
- [ ] Decks: deck sin la acción habilitada no permite crear
- [ ] Costos: tokens se descuentan correctamente
- [ ] DataTable del historial muestra la acción

---

## Resumen rápido (archivos mínimos)

| Componente | Archivo | Qué agregar |
|---|---|---|
| Panel | `pages/{tipo}.php` | Página completa |
| Panel | `resources/sidebar.json` | Entrada de menú |
| Panel | `pages/usuarios.php` | Permiso en `$permisosDisponibles` |
| Panel | `pages/clientes.php` | Acción en 3 arrays |
| Panel | `resources/costosglobales.json` | Costo default |
| Panel | `pages/costos.php` | 2 arrays (default + nombre) |
| Panel | `api/actions_tables.php` | Delete link + formato (si especial) |
| Worker | `src/threads/{tipo}Thread.js` | Thread completo |
| Worker | `src/request/src/request.js` | Función de request |
| Worker | `src/request/base.js` | Case en switch |
| Worker | `src/services/socket.js` | `ACTION_TYPES` array |
| Worker | `src/config.js` | `maxThreads` entry |
| Worker | `src/puppeteer/base.js` | Case en switch (si usa browser) |
