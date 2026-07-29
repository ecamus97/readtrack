# ReadTrack

Plataforma personal/familiar para trackear libros leídos, en curso y por leer, con dashboard, logros, clubes de lectura y comparativa entre contactos.

Corre en producción sobre **Supabase** (Postgres + autenticación real por email/contraseña) y se despliega en **Render**.

## Variables de entorno necesarias

Copia estas variables a un archivo `.env` en `readtrack/` para correr localmente, y configúralas también como "Environment Variables" en Render (ver más abajo):

```
GOOGLE_BOOKS_API_KEY=...
SUPABASE_URL=https://TU-PROYECTO.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
DATABASE_URL=postgresql://postgres:TU_PASSWORD@db.TU-PROYECTO.supabase.co:5432/postgres
```

Importante: si tu contraseña de la base de datos tiene caracteres especiales (`$`, `@`, `:`, `/`, etc.), tienes que codificarlos como "percent-encoding" en la URL (por ejemplo `$` se escribe `%24`) o la conexión va a fallar o, peor, va a conectarse con la contraseña equivocada sin avisar.

El `SUPABASE_ANON_KEY` también está pegado directamente en `public/index.html` (es la clave "pública" del proyecto — está diseñada para vivir en el navegador, a diferencia de `SUPABASE_SERVICE_ROLE_KEY`, que nunca debe salir del servidor).

## Paso 1 — Correr el schema en Supabase

1. Entra a tu proyecto en [supabase.com](https://supabase.com) → **SQL Editor** → **New query**.
2. Pega el contenido completo de `schema.sql` (en la raíz de `readtrack/`) y ejecútalo. Es seguro correrlo más de una vez.
3. Esto crea todas las tablas (`profiles`, `books`, `user_books`, `contacts`, `goals`, `invites`, `book_clubs`, etc.) y un trigger que crea automáticamente el `profile` de cada persona apenas se registra.

## Paso 2 — Correr localmente (opcional, para probar antes de desplegar)

Requiere Node.js 22.5+.

```bash
cd readtrack
npm install
npm start
```

Abre `http://localhost:3300`. La primera vez, crea tu cuenta desde la pantalla de "Sign up" (nombre, usuario, email, contraseña) — ya no hay selector de cuentas ni botón de "cuenta nueva" sin contraseña, cada persona inicia sesión con su propio email.

## Paso 3 — Desplegar en Render

1. Sube este proyecto a un repositorio de GitHub (el `.gitignore` ya excluye `.env` y `node_modules`, así que las claves no se suben).
2. En Render: **New** → **Web Service** → conecta el repositorio.
3. Configuración del servicio:
   - **Root directory**: `readtrack` (si el repo tiene la carpeta en la raíz del repo, déjalo vacío)
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free está bien para uso personal/familiar
4. En la sección **Environment**, agrega las mismas variables del `.env` (GOOGLE_BOOKS_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL). Render define `PORT` automáticamente, no hace falta agregarla.
5. Deploy. Render te da una URL pública (`https://tu-app.onrender.com`) — esa es la URL de producción para compartir con tu grupo.

Nota: el plan gratuito de Render "duerme" el servicio tras un rato sin uso, y la primera visita después de eso tarda unos segundos en despertar. Es un comportamiento normal del plan free, no un error.

## Qué incluye

- **Autenticación real** (Supabase Auth, email + contraseña) — cada persona tiene su propia cuenta y sesión; el servidor nunca confía en un `user_id` que mande el navegador, siempre lo deriva del token de sesión verificado.
- **Catálogo único de libros** compartido entre todos los usuarios, para no duplicar llamadas a APIs externas.
- **Búsqueda y enriquecimiento automático** de páginas/categorías (Open Library + Google Books).
- **Mi librería** con vista de lista y vista de **calendario** (arrastra/programa fechas de inicio y fin estimadas).
- **Home** con libros en lectura actual, metas anuales/mensuales, métricas, gustos de lectura y gráficos de evolución.
- **Social**: feed de actividad de tus contactos, contactos por username o código de invitación, y **clubes de lectura** (metas semanales compartidas, progreso por miembro).
- **Logros/achievements** categorizados.
- App instalable como **PWA** (ícono, manifest) y con diseño responsive para celular.

## Estructura

```
readtrack/
  schema.sql    -> schema de Postgres (correr una vez en Supabase SQL Editor)
  db.js         -> capa de acceso a datos (pg / Postgres)
  auth.js       -> middleware que verifica el token de sesión de Supabase
  server.js     -> API (Express)
  public/       -> frontend (HTML/CSS/JS vanilla, sin build step)
  seed.js       -> [obsoleto] sembraba datos en la versión anterior con SQLite local; no aplica a Postgres/producción
```
