# ReadTrack (prototipo)

Plataforma personal para trackear libros leídos, en curso y por leer, con indicadores de lectura y comparativa entre contactos.

## Cómo correrlo

Requiere Node.js 22.5 o superior (usa el módulo `node:sqlite` incluido en Node, así que no necesita instalar SQLite ni compilar nada nativo).

```bash
cd readtrack
npm install
npm run seed     # crea la base de datos con 2 usuarios de ejemplo y 3 libros
npm start         # levanta el servidor en http://localhost:3300
```

Abre `http://localhost:3300` en el navegador.

## Mejorar el auto-completado de páginas/categorías (opcional, recomendado)

Sin ninguna configuración extra, la app ya intenta rellenar páginas y categorías automáticamente usando Open Library (gratis, sin límite de uso) y, como bonus, Google Books. El problema es que Google Books sin API key tiene una cuota diaria gratuita muy baja compartida entre todos los que no configuran su propia key, así que se agota rápido (vas a ver errores 429 en la terminal cuando pasa).

Para tener una cuota propia y mucho más generosa (gratis, no requiere tarjeta de crédito para el uso normal de esta app):

1. Ve a [Google Cloud Console](https://console.cloud.google.com/), crea un proyecto nuevo (o usa uno existente).
2. Busca "Books API" en el buscador de APIs, ábrela y presiona "Habilitar".
3. Ve a "Credenciales" → "Crear credenciales" → "Clave de API". Copia la clave que te genera.
4. En la carpeta `readtrack`, crea un archivo llamado `.env` (así, con el punto adelante) con esta línea adentro:

```
GOOGLE_BOOKS_API_KEY=tu_clave_aqui
```

5. Reinicia el servidor (`npm start`). No hace falta ningún cambio de código, el servidor lee este archivo solo.

Si no configuras nada, la app sigue funcionando igual, solo que depende más de Open Library (que en general es suficiente, pero a veces le faltan páginas o categorías a libros específicos).

## Qué incluye este prototipo

- **Catálogo único de libros** compartido entre todos los usuarios (tabla `books`), evitando llamadas duplicadas a la API externa.
- **Búsqueda de libros** vía Google Books API (gratis, sin API key) desde la pestaña "Buscar y agregar".
- **Mi librería**: cambiar estado (por leer / leyendo / leído), poner rating al terminar un libro.
- **Dashboard** con: ritmo y volumen (libros/páginas leídas, días promedio por libro), metas anuales y progreso, top autores/géneros, rating promedio.
- **Contactos**: agregar contacto (queda pendiente), aceptar solicitud, y comparar estadísticas + libros en común solo entre contactos aceptados.
- Selector de usuario en la parte superior para simular multiusuario sin tener que armar login todavía.

## Limitaciones de este prototipo (a resolver antes de un uso real)

- No hay autenticación real (contraseñas, sesiones). El "selector de usuario" es solo para probar la lógica multiusuario.
- Base de datos SQLite local (`readtrack.db`). Para producción con más gente, migrar a Postgres (ej. Supabase/Neon) es directo porque el esquema ya está normalizado.
- La búsqueda de libros depende de que Google Books API esté disponible desde donde corras el servidor; si algún libro no aparece bien, se puede agregar como fallback Open Library API.
- Falta paginación, manejo de errores más fino en la UI, y edición de notas de libros desde la interfaz (el campo existe en la base de datos).

## Estructura

```
readtrack/
  db.js        -> esquema de base de datos (users, books, user_books, contacts, goals)
  seed.js       -> datos de ejemplo
  server.js     -> API (Express)
  public/       -> frontend (HTML/CSS/JS vanilla)
```
