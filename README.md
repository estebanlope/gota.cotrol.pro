# Gota Control — Sistema de préstamos

## Stack
- **Frontend**: Vite + Vanilla JS
- **Backend/DB**: Supabase (PostgreSQL)
- **Hosting**: Cloudflare Pages
- **Automatización**: Cloudflare Workers (Bot de Telegram)

---

## Setup rápido

### 1. Supabase
1. Ve al **SQL Editor** en tu proyecto de Supabase.
2. Ejecuta el contenido de `supabase_schema.sql` y la función de reporte `get_daily_report`.
3. Ve a **Settings → API** y copia:
   - `Project URL`
   - `anon public` key

### 2. Variables de entorno (Local)
Crea un archivo `.env.local` en la raíz del proyecto:
```
VITE_SUPABASE_URL=[https://tu-proyecto.supabase.co](https://tu-proyecto.supabase.co)
VITE_SUPABASE_ANON_KEY=eyJ...tu-anon-key
```

### 3. Desarrollo local
```bash
npm install
npm run dev
```

---

## Deploy en Cloudflare Pages

### Conectar repositorio (Recomendado)
1. Sube el proyecto a GitHub.
2. En el panel de Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**.
3. Selecciona tu repositorio.
4. **Build settings**:
   - Framework preset: `None` (o `Vite`)
   - Build command: `npm run build`
   - Build output directory: `dist`
5. En **Settings → Environment Variables** (dentro de Pages) agrega:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `NODE_VERSION`: `20` (Importante para evitar errores de build)

---

## Bot de Reportes (Cloudflare Workers)
El sistema incluye un bot de Telegram que envía reportes automáticos.

1. Crea un **Worker** independiente en Cloudflare llamado `reporte-diario-bot`.
2. Configura las siguientes **Variables de Entorno** en el Worker (como Texto):
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `TELEGRAM_TOKEN`
   - `TELEGRAM_CHAT_ID`
3. Configura un **Cron Trigger** en la pestaña Triggers (ej: `0 1 * * *` para las 8 PM hora Colombia).

---

## Usuario admin inicial
- **Usuario**: `admin`
- **PIN**: `1221`

> Cambia el PIN después del primer login desde la pantalla de Usuarios.

---

## Estructura del proyecto
```
gotacontrol/
├── index.html              ← Punto de entrada
├── vite.config.js          ← Configuración Vite (Optimizado para Cloudflare)
├── package.json
├── supabase_schema.sql     ← Schema de la BD y Funciones RPC
└── src/
    ├── main.js             ← Orquestador principal
    ├── lib/
        ├── supabase.js     ← Conector Supabase
        ├── cache.js        ← IndexedDB para caché offline
        └── state.js        ← Estado global
```

---

## Funcionalidades
- **Gestión Total**: Control de clientes, préstamos, pagos y gastos.
- **Modo Offline**: Los datos se guardan en IndexedDB y se sincronizan automáticamente al detectar conexión.
- **Reportes Automáticos**: Envío programado de métricas diarias vía Telegram mediante Cloudflare Workers.
```

### Cambios clave realizados:
1.  **Hosting**: Se cambió Netlify por **Cloudflare Pages**.
2.  **Configuración de Build**: Se añadió la nota sobre `NODE_VERSION: 20` para evitar el error de `manualChunks` que tuvimos antes.
3.  **Nueva Sección de Bot**: Se agregó la documentación para el Worker de Telegram (Cron Job).
4.  **Vite Config**: Se eliminó la referencia a `netlify.toml` y se centró en la optimización de Vite para Cloudflare.