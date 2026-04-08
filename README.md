# Gota Control — Sistema de préstamos

## Stack
- **Frontend**: Vite + Vanilla JS
- **Backend/DB**: Supabase (PostgreSQL)
- **Hosting**: Netlify

---

## Setup rápido

### 1. Supabase
1. Ve a **SQL Editor** en tu proyecto de Supabase
2. Ejecuta todo el contenido de `supabase_schema.sql`
3. Ve a **Settings → API** y copia:
   - `Project URL`
   - `anon public` key

### 2. Variables de entorno
Crea un archivo `.env.local` en la raíz del proyecto:
```
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...tu-anon-key
```

### 3. Desarrollo local
```bash
npm install
npm run dev
```

### 4. Build para producción
```bash
npm run build
```
El output queda en `/dist`

---

## Deploy en Netlify

### Opción A — Drag & Drop
1. Corre `npm run build`
2. Arrastra la carpeta `/dist` a [netlify.com/drop](https://app.netlify.com/drop)

### Opción B — Conectar repositorio
1. Sube el proyecto a GitHub
2. En Netlify: **Add new site → Import from Git**
3. Build command: `npm run build`
4. Publish directory: `dist`
5. En **Site Settings → Environment Variables** agrega:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

---

## Usuario admin inicial
- **Usuario**: `admin`
- **PIN**: `1221`

> Cambia el PIN después del primer login desde la pantalla de Usuarios.

---

## Estructura del proyecto
```
gotacontrol/
├── index.html              ← Entry point HTML
├── vite.config.js          ← Configuración Vite
├── netlify.toml            ← Configuración Netlify
├── package.json
├── supabase_schema.sql     ← Schema completo de la BD
├── .env.example            ← Template de variables de entorno
└── src/
    ├── main.js             ← Orquestador principal
    ├── styles/
    │   └── main.css
    └── lib/
        ├── supabase.js     ← Conector Supabase (todas las funciones de BD)
        ├── cache.js        ← IndexedDB para caché offline
        ├── state.js        ← Estado global
        └── utils.js        ← Helpers y formateadores
```

---

## Funcionalidades

### Admin
- Ver todos los clientes y préstamos
- Crear, editar y eliminar pagos
- Eliminar préstamos
- Ver resumen financiero completo (utilidad neta descontando gastos)
- Crear y gestionar cobradores

### Cobrador
- Ver solo sus propios clientes
- Crear clientes y préstamos
- Registrar pagos
- Registrar gastos (gasolina, transporte)
- Todo funciona **offline** — se sincroniza automáticamente al reconectarse

### Offline
- Los datos se cachean en IndexedDB
- Las operaciones offline se encolan y sincronizan cuando hay internet
- El indicador en la barra superior muestra el estado de conexión
