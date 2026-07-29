const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');

// Carga manual de un archivo .env opcional (sin dependencias externas), para
// poder guardar una API key de Google Books sin tener que exportarla cada vez
// que se levanta el servidor. Ver README para cómo conseguir la key gratis.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
})();

const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY || '';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Usuarios ----------

app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT id, name, username, email, avatar_seed FROM users ORDER BY name').all();
  res.json(users);
});

app.post('/api/users', (req, res) => {
  const { name, email, username, avatar_seed } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const info = db.prepare('INSERT INTO users (name, email, username, avatar_seed) VALUES (?, ?, ?, ?)')
      .run(name, email || null, username || null, avatar_seed || username || name);
    res.json({ id: info.lastInsertRowid, name, email, username, avatar_seed: avatar_seed || username || name });
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That username is already taken' });
    }
    throw err;
  }
});

app.patch('/api/users/:id', (req, res) => {
  const { name, avatar_seed } = req.body;
  const fields = [];
  const values = [];
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (avatar_seed !== undefined) { fields.push('avatar_seed = ?'); values.push(avatar_seed); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// Looks up a user by their unique username, used when sending a contact
// request by username instead of picking from a list of every user.
app.get('/api/users/lookup', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username is required' });
  const user = db.prepare('SELECT id, name, username FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: 'No user found with that username' });
  res.json(user);
});

// ---------- Busqueda de libros (Google Books API) ----------

// Si hay una API key configurada (ver .env / README), se usa: sube muchísimo
// la cuota diaria gratuita respecto a no usar ninguna key.
function withGoogleKey(url) {
  return GOOGLE_BOOKS_API_KEY ? `${url}&key=${GOOGLE_BOOKS_API_KEY}` : url;
}

async function searchGoogleBooks(q) {
  const url = withGoogleKey(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=10`);
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok || data.error) {
    // Google Books devuelve status 200 casi siempre, pero por si acaso
    // (cuota excedida, request mal formado, etc.) lo dejamos logueado.
    console.error('Google Books returned an error:', r.status, JSON.stringify(data.error || data));
    return null; // null = "hubo un problema", distinto de [] = "no hay resultados"
  }
  return (data.items || []).map(item => {
    const info = item.volumeInfo || {};
    const isbn = (info.industryIdentifiers || []).find(i => i.type === 'ISBN_13')?.identifier
      || (info.industryIdentifiers || [])[0]?.identifier || null;
    return {
      api_id: item.id,
      isbn,
      title: info.title || 'Untitled',
      authors: (info.authors || []).join(', '),
      cover_url: info.imageLinks?.thumbnail || (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg` : null),
      pages: info.pageCount || null,
      published_year: info.publishedDate ? parseInt(info.publishedDate.slice(0, 4)) : null,
      categories: (info.categories || []).join(', '),
      language: info.language || null
    };
  });
}

async function searchOpenLibrary(q) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=10`;
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok) {
    console.error('Open Library returned an error:', r.status);
    return null;
  }
  return (data.docs || []).map(d => ({
    api_id: `ol-${d.key}`,
    isbn: d.isbn?.[0] || null,
    title: d.title || 'Untitled',
    authors: (d.author_name || []).join(', '),
    cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : (d.isbn?.[0] ? `https://covers.openlibrary.org/b/isbn/${d.isbn[0]}-M.jpg` : null),
    pages: d.number_of_pages_median || null,
    published_year: d.first_publish_year || null,
    categories: (d.subject || []).slice(0, 3).join(', '),
    language: (d.language || [])[0] || null
  }));
}

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q is required' });

  // Se intenta primero con Google Books (mejor cobertura de portadas) y si
  // falla o no trae resultados, se cae a Open Library como respaldo.
  let results = null;
  try {
    results = await searchGoogleBooks(q);
  } catch (err) {
    console.error('Fallo al llamar a Google Books API:', err.message);
  }

  if (!results || results.length === 0) {
    try {
      const fallback = await searchOpenLibrary(q);
      if (fallback && fallback.length) results = fallback;
    } catch (err) {
      console.error('Fallo al llamar a Open Library API:', err.message);
    }
  }

  if (results === null) {
    return res.status(502).json({ error: 'Could not reach any book API. Check the server terminal for details.' });
  }
  res.json(results);
});

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Si a un libro le faltan páginas o categorías se intenta completar probando
// varias fuentes en orden. Open Library va primero porque no tiene límite de
// cuota; Google Books queda como bonus al final porque su cuota gratuita sin
// API key se agota rápido (se ve como error 429 en los logs si pasa).
// Cada paso deja un console.log/error para poder diagnosticar desde la
// terminal si algún libro puntual sigue sin completarse.
async function enrichBook(book) {
  if (book.pages && book.categories) return book;
  console.log(`[enrich] "${book.title}" — missing: ${!book.pages ? 'pages ' : ''}${!book.categories ? 'categories' : ''}`);

  let workKey = null;

  // 1) Open Library: buscar por título + autor. Sin límite de cuota, así que
  // es la fuente principal. El resultado trae isbn y el "work key", que se
  // usan después para ir a buscar el detalle completo (páginas y subjects).
  if ((!book.pages || !book.categories) && book.title) {
    try {
      const params = new URLSearchParams({ title: book.title, limit: '1' });
      if (book.authors) params.set('author', book.authors.split(',')[0].trim());
      const r = await fetchWithTimeout(`https://openlibrary.org/search.json?${params.toString()}`, 4000);
      if (r.ok) {
        const data = await r.json();
        const doc = data.docs?.[0];
        if (doc) {
          if (!book.isbn && doc.isbn?.[0]) book.isbn = doc.isbn[0];
          if (!book.pages && doc.number_of_pages_median) book.pages = doc.number_of_pages_median;
          if (!book.categories && doc.subject?.length) book.categories = doc.subject.slice(0, 3).join(', ');
          workKey = doc.key || null;
          console.log(`[enrich]   Open Library (search) found doc: isbn=${doc.isbn?.[0]}, pages=${doc.number_of_pages_median}, workKey=${workKey}`);
        } else {
          console.log('[enrich]   Open Library (search) found no results');
        }
      } else {
        console.log(`[enrich]   Open Library (search) responded ${r.status}`);
      }
    } catch (err) {
      console.error('[enrich]   Open Library (search) failed:', err.message);
    }
  }

  // 2) Si hay ISBN (propio o recién encontrado) y aún falta algo, el detalle
  // por ISBN suele traer el número de páginas más preciso.
  if (book.isbn && (!book.pages || !book.categories)) {
    try {
      const r = await fetchWithTimeout(`https://openlibrary.org/isbn/${book.isbn}.json`, 4000);
      if (r.ok) {
        const data = await r.json();
        if (!book.pages && data.number_of_pages) book.pages = data.number_of_pages;
        if (!book.categories && Array.isArray(data.subjects) && data.subjects.length) {
          book.categories = data.subjects.slice(0, 3).join(', ');
        }
        workKey = workKey || data.works?.[0]?.key || null;
        console.log(`[enrich]   Open Library (isbn) found: pages=${data.number_of_pages}, subjects=${(data.subjects || []).slice(0, 3)}`);
      } else {
        console.log(`[enrich]   Open Library (isbn) responded ${r.status}`);
      }
    } catch (err) {
      console.error('[enrich]   Open Library (isbn) failed:', err.message);
    }
  }

  // 3) El "work" en Open Library suele traer subjects/géneros más completos
  // que el registro por ISBN o el resultado de búsqueda.
  if (!book.categories && workKey) {
    try {
      const r = await fetchWithTimeout(`https://openlibrary.org${workKey}.json`, 4000);
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data.subjects) && data.subjects.length) {
          book.categories = data.subjects.slice(0, 3).join(', ');
          console.log(`[enrich]   Open Library (work) found subjects: ${data.subjects.slice(0, 3)}`);
        }
      }
    } catch (err) {
      console.error('[enrich]   Open Library (work) failed:', err.message);
    }
  }

  // 4) Si todavía falta el número de páginas, se revisan las ediciones del
  // "work": el resultado de búsqueda muchas veces no trae number_of_pages,
  // pero casi siempre alguna de sus ediciones individuales sí lo tiene.
  if (!book.pages && workKey) {
    try {
      const r = await fetchWithTimeout(`https://openlibrary.org${workKey}/editions.json?limit=20`, 4000);
      if (r.ok) {
        const data = await r.json();
        const withPages = (data.entries || []).find(e => e.number_of_pages);
        if (withPages) {
          book.pages = withPages.number_of_pages;
          if (!book.isbn && withPages.isbn_13?.[0]) book.isbn = withPages.isbn_13[0];
          console.log(`[enrich]   Open Library (editions) found pages=${withPages.number_of_pages}`);
        } else {
          console.log(`[enrich]   Open Library (editions) checked ${data.entries?.length || 0} editions, none with page count`);
        }
      }
    } catch (err) {
      console.error('[enrich]   Open Library (editions) failed:', err.message);
    }
  }

  // 5) Google Books como último recurso (bonus): su cuota gratuita sin API
  // key es muy limitada y puede devolver 429, pero si funciona (o si hay una
  // API key configurada en .env) puede traer datos que Open Library no tenga.
  if (!book.pages || !book.categories) {
    try {
      const query = `${book.title} ${book.authors || ''}`.trim();
      const results = await searchGoogleBooks(query);
      const match = results?.[0];
      if (match) {
        if (!book.isbn && match.isbn) book.isbn = match.isbn;
        if (!book.pages && match.pages) book.pages = match.pages;
        if (!book.categories && match.categories) book.categories = match.categories;
        console.log(`[enrich]   Google Books found: pages=${match.pages}, categories=${match.categories}`);
      }
    } catch (err) {
      console.error('[enrich]   Google Books failed:', err.message);
    }
  }

  console.log(`[enrich] final result "${book.title}": pages=${book.pages || 'no data'}, categories=${book.categories || 'no data'}`);
  return book;
}

// Endpoint que el frontend llama justo antes de mostrar el modal de "agregar",
// para que páginas/categorías ya vengan completas y el usuario casi nunca
// tenga que tipearlas a mano (solo queda como respaldo editable).
app.post('/api/enrich', async (req, res) => {
  const book = { ...req.body };
  await enrichBook(book);
  res.json(book);
});

// ---------- Catalogo de libros ----------

// node:sqlite no trae un helper de transacciones como better-sqlite3,
// asi que envolvemos manualmente con BEGIN/COMMIT/ROLLBACK.
function findOrCreateBook(b) {
  const existing = db.prepare('SELECT * FROM books WHERE api_id = ?').get(b.api_id);
  if (existing) return existing;
  const params = {
    api_id: b.api_id,
    isbn: b.isbn || null,
    title: b.title,
    authors: b.authors || null,
    cover_url: b.cover_url || null,
    pages: b.pages || null,
    published_year: b.published_year || null,
    categories: b.categories || null,
    language: b.language || null
  };
  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      INSERT INTO books (api_id, isbn, title, authors, cover_url, pages, published_year, categories, language)
      VALUES (@api_id, @isbn, @title, @authors, @cover_url, @pages, @published_year, @categories, @language)
    `).run(params);
    const row = db.prepare('SELECT * FROM books WHERE id = ?').get(info.lastInsertRowid);
    db.exec('COMMIT');
    return row;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

app.post('/api/books', async (req, res) => {
  const b = req.body;
  if (!b.title) return res.status(400).json({ error: 'title is required' });
  b.api_id = b.api_id || `manual-${b.isbn || b.title}`;
  await enrichBook(b);
  const book = findOrCreateBook(b);
  res.json(book);
});

// Re-intenta completar páginas/categorías de un libro que ya está en el
// catálogo (por ejemplo uno agregado antes de tener este enriquecimiento) y
// guarda lo que encuentre. Como el catálogo es compartido, esto beneficia a
// todos los usuarios que tengan ese libro, no solo a quien lo pidió.
app.post('/api/books/:id/refresh', async (req, res) => {
  const existing = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Book not found' });
  const enriched = await enrichBook({ ...existing });
  db.prepare('UPDATE books SET pages = ?, categories = ?, isbn = ? WHERE id = ?')
    .run(enriched.pages || null, enriched.categories || null, enriched.isbn || existing.isbn || null, existing.id);
  const updated = db.prepare('SELECT * FROM books WHERE id = ?').get(existing.id);
  res.json(updated);
});

// ---------- Mi libreria (user_books) ----------

app.post('/api/user-books', async (req, res) => {
  const { user_id, book, status, rating, start_date, end_date } = req.body;
  if (!user_id || !book) return res.status(400).json({ error: 'user_id and book are required' });
  book.api_id = book.api_id || `manual-${book.isbn || book.title}`;
  await enrichBook(book);
  const bookRow = findOrCreateBook(book);
  try {
    const info = db.prepare(`
      INSERT INTO user_books (user_id, book_id, status, rating, start_date, end_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user_id, bookRow.id, status || 'por_leer', rating || null, start_date || null, end_date || null);
    res.json({ id: info.lastInsertRowid, book_id: bookRow.id });
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That book is already in your list' });
    }
    throw err;
  }
});

app.get('/api/user-books', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  const rows = db.prepare(`
    SELECT ub.id, ub.status, ub.rating, ub.notes, ub.start_date, ub.end_date,
           ub.planned_start_date, ub.planned_end_date,
           b.id as book_id, b.title, b.authors, b.cover_url, b.pages, b.published_year, b.categories, b.language
    FROM user_books ub JOIN books b ON b.id = ub.book_id
    WHERE ub.user_id = ?
    ORDER BY ub.created_at DESC
  `).all(user_id);
  res.json(rows);
});

app.patch('/api/user-books/:id', (req, res) => {
  const { status, rating, notes, start_date, end_date, planned_start_date, planned_end_date } = req.body;
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries({ status, rating, notes, start_date, end_date, planned_start_date, planned_end_date })) {
    if (v !== undefined) { fields.push(`${k} = ?`); values.push(v); }
  }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE user_books SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

app.delete('/api/user-books/:id', (req, res) => {
  db.prepare('DELETE FROM user_books WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Metas ----------

app.post('/api/goals', (req, res) => {
  const { user_id, year, target_books, monthly_target } = req.body;
  db.prepare(`
    INSERT INTO goals (user_id, year, target_books, monthly_target) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, year) DO UPDATE SET
      target_books = excluded.target_books,
      monthly_target = excluded.monthly_target
  `).run(user_id, year, target_books || null, monthly_target || null);
  res.json({ ok: true });
});

app.get('/api/goals', (req, res) => {
  const { user_id, year } = req.query;
  if (year) {
    const row = db.prepare('SELECT year, target_books, monthly_target FROM goals WHERE user_id = ? AND year = ?').get(user_id, year);
    return res.json(row || null);
  }
  const rows = db.prepare('SELECT year, target_books, monthly_target FROM goals WHERE user_id = ? ORDER BY year DESC').all(user_id);
  res.json(rows);
});

// ---------- Contactos ----------

app.post('/api/contacts', (req, res) => {
  const { user_id, contact_user_id, contact_username } = req.body;
  let targetId = contact_user_id;
  if (!targetId && contact_username) {
    const target = db.prepare('SELECT id FROM users WHERE username = ?').get(contact_username);
    if (!target) return res.status(404).json({ error: 'No user found with that username' });
    targetId = target.id;
  }
  if (!targetId) return res.status(400).json({ error: 'contact_user_id or contact_username is required' });
  if (parseInt(targetId) === parseInt(user_id)) return res.status(400).json({ error: "You can't add yourself" });
  db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, ?)').run(user_id, targetId, 'pendiente');
  res.json({ ok: true });
});

app.post('/api/contacts/:id/accept', (req, res) => {
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE contacts SET status = ? WHERE id = ?').run('aceptado', req.params.id);
  db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, ?)')
    .run(row.contact_user_id, row.user_id, 'aceptado');
  res.json({ ok: true });
});

app.get('/api/contacts', (req, res) => {
  const { user_id } = req.query;
  // Contactos aceptados + solicitudes que YO envié y siguen pendientes.
  const rows = db.prepare(`
    SELECT c.id, c.status, u.id as contact_user_id, u.name, u.email
    FROM contacts c JOIN users u ON u.id = c.contact_user_id
    WHERE c.user_id = ?
    ORDER BY c.status DESC, u.name
  `).all(user_id);
  res.json(rows);
});

app.get('/api/contacts/incoming', (req, res) => {
  const { user_id } = req.query;
  // Solicitudes que otros me enviaron y aun no he aceptado.
  const rows = db.prepare(`
    SELECT c.id, u.id as requester_id, u.name, u.email
    FROM contacts c JOIN users u ON u.id = c.user_id
    WHERE c.contact_user_id = ? AND c.status = 'pendiente'
  `).all(user_id);
  res.json(rows);
});

app.delete('/api/contacts', (req, res) => {
  const { user_id, contact_user_id } = req.body;
  if (!user_id || !contact_user_id) return res.status(400).json({ error: 'user_id and contact_user_id are required' });
  db.prepare('DELETE FROM contacts WHERE (user_id = ? AND contact_user_id = ?) OR (user_id = ? AND contact_user_id = ?)')
    .run(user_id, contact_user_id, contact_user_id, user_id);
  res.json({ ok: true });
});

// ---------- Invite codes ----------
// Whoever creates a code becomes an accepted contact automatically of
// whoever redeems it — no manual request/accept step needed for that pair.

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

app.post('/api/invites', (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  let code;
  do { code = generateInviteCode(); } while (db.prepare('SELECT 1 FROM invites WHERE code = ?').get(code));
  db.prepare('INSERT INTO invites (code, created_by) VALUES (?, ?)').run(code, user_id);
  res.json({ code });
});

// Redeems a code by creating a brand-new account (used from the "New
// account" flow, for someone who doesn't have a profile in this app yet).
app.post('/api/invites/redeem', (req, res) => {
  const { code, name, username, avatar_seed } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
  const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(code.toUpperCase());
  if (!invite) return res.status(404).json({ error: 'Invalid invite code' });
  if (invite.used_by) return res.status(409).json({ error: 'This invite code was already used' });

  let newUser;
  try {
    const info = db.prepare('INSERT INTO users (name, username, avatar_seed) VALUES (?, ?, ?)')
      .run(name, username || null, avatar_seed || username || name);
    newUser = { id: info.lastInsertRowid, name, username, avatar_seed: avatar_seed || username || name };
  } catch (err) {
    if (String(err).includes('UNIQUE')) return res.status(409).json({ error: 'That username is already taken' });
    throw err;
  }

  db.prepare('UPDATE invites SET used_by = ?, used_at = datetime(\'now\') WHERE id = ?').run(newUser.id, invite.id);
  db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, ?)').run(invite.created_by, newUser.id, 'aceptado');
  db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, ?)').run(newUser.id, invite.created_by, 'aceptado');

  res.json(newUser);
});

// Redeems a code for a user who already has a profile in this app: just
// links the two accounts as accepted contacts, no new account is created.
app.post('/api/invites/redeem-existing', (req, res) => {
  const { code, user_id } = req.body;
  if (!code || !user_id) return res.status(400).json({ error: 'code and user_id are required' });
  const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(code.toUpperCase());
  if (!invite) return res.status(404).json({ error: 'Invalid invite code' });
  if (invite.used_by) return res.status(409).json({ error: 'This invite code was already used' });
  if (invite.created_by === parseInt(user_id)) return res.status(400).json({ error: "You can't redeem your own code" });

  db.prepare('UPDATE invites SET used_by = ?, used_at = datetime(\'now\') WHERE id = ?').run(user_id, invite.id);
  db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, ?)').run(invite.created_by, user_id, 'aceptado');
  db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, ?)').run(user_id, invite.created_by, 'aceptado');

  const creator = db.prepare('SELECT name FROM users WHERE id = ?').get(invite.created_by);
  res.json({ ok: true, contactName: creator?.name || null });
});

// ---------- Dashboard / stats ----------

function computeStats(user_id) {
  const books = db.prepare(`
    SELECT ub.*, b.pages, b.authors, b.categories, b.language
    FROM user_books ub JOIN books b ON b.id = ub.book_id
    WHERE ub.user_id = ?
  `).all(user_id);

  const leidos = books.filter(b => b.status === 'leido');

  // Ritmo y volumen: agrupado por mes (usando end_date)
  const porMes = {};
  const paginasPorMes = {};
  for (const b of leidos) {
    if (!b.end_date) continue;
    const mes = b.end_date.slice(0, 7); // YYYY-MM
    porMes[mes] = (porMes[mes] || 0) + 1;
    paginasPorMes[mes] = (paginasPorMes[mes] || 0) + (b.pages || 0);
  }

  const totalPaginas = leidos.reduce((sum, b) => sum + (b.pages || 0), 0);

  const diasPromedio = (() => {
    const conFechas = leidos.filter(b => b.start_date && b.end_date);
    if (!conFechas.length) return null;
    const total = conFechas.reduce((sum, b) => {
      const d = (new Date(b.end_date) - new Date(b.start_date)) / (1000 * 60 * 60 * 24);
      return sum + d;
    }, 0);
    return Math.round(total / conFechas.length);
  })();

  // Gustos y patrones
  const contarCsv = (campo) => {
    const counts = {};
    for (const b of leidos) {
      if (!b[campo]) continue;
      for (const v of b[campo].split(',').map(s => s.trim()).filter(Boolean)) {
        counts[v] = (counts[v] || 0) + 1;
      }
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  };

  const topAutores = contarCsv('authors');
  const topGeneros = contarCsv('categories');

  const ratings = leidos.filter(b => b.rating != null).map(b => b.rating);
  const ratingPromedio = ratings.length ? +(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2) : null;
  const rating5Count = leidos.filter(b => b.rating === 5).length;

  const maxPaginasLibro = leidos.reduce((max, b) => Math.max(max, b.pages || 0), 0);

  const lecturaMasRapidaDias = (() => {
    const conFechas = leidos.filter(b => b.start_date && b.end_date);
    if (!conFechas.length) return null;
    const dias = conFechas.map(b => Math.max(0, Math.round((new Date(b.end_date) - new Date(b.start_date)) / (1000 * 60 * 60 * 24))));
    return Math.min(...dias);
  })();

  // Longest streak of consecutive calendar months with at least one finished book.
  const mesesConsecutivos = (() => {
    const meses = Object.keys(porMes).sort();
    if (!meses.length) return 0;
    let maxStreak = 1, streak = 1;
    for (let i = 1; i < meses.length; i++) {
      const [py, pm] = meses[i - 1].split('-').map(Number);
      const [cy, cm] = meses[i].split('-').map(Number);
      const diff = (cy - py) * 12 + (cm - pm);
      streak = diff === 1 ? streak + 1 : 1;
      maxStreak = Math.max(maxStreak, streak);
    }
    return maxStreak;
  })();

  // Metas y progreso
  const anioActual = new Date().getFullYear();
  const mesActual = String(new Date().getMonth() + 1).padStart(2, '0');
  const claveMesActual = `${anioActual}-${mesActual}`;
  const meta = db.prepare('SELECT target_books, monthly_target FROM goals WHERE user_id = ? AND year = ?').get(user_id, anioActual);
  const leidosEsteAnio = leidos.filter(b => b.end_date && b.end_date.startsWith(String(anioActual))).length;
  const leidosEsteMes = porMes[claveMesActual] || 0;

  return {
    total_leidos: leidos.length,
    total_leyendo: books.filter(b => b.status === 'leyendo').length,
    total_por_leer: books.filter(b => b.status === 'por_leer').length,
    total_libros_biblioteca: books.length,
    total_paginas: totalPaginas,
    max_paginas_libro: maxPaginasLibro,
    dias_promedio_por_libro: diasPromedio,
    lectura_mas_rapida_dias: lecturaMasRapidaDias,
    meses_consecutivos: mesesConsecutivos,
    por_mes: porMes,
    paginas_por_mes: paginasPorMes,
    top_autores: topAutores,
    top_generos: topGeneros,
    rating_promedio: ratingPromedio,
    rating_5_count: rating5Count,
    meta_anual: meta ? meta.target_books : null,
    meta_mensual: meta ? meta.monthly_target : null,
    leidos_este_anio: leidosEsteAnio,
    leidos_este_mes: leidosEsteMes,
    anio: anioActual
  };
}

app.get('/api/stats', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  res.json(computeStats(user_id));
});

// What the user is reading right now, tagged with whether it's a personal
// pick or something a book club of theirs is reading together.
app.get('/api/reading-now', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const rows = db.prepare(`
    SELECT ub.id, ub.start_date, b.id as book_id, b.title, b.authors, b.cover_url, b.pages
    FROM user_books ub JOIN books b ON b.id = ub.book_id
    WHERE ub.user_id = ? AND ub.status = 'leyendo'
    ORDER BY ub.start_date DESC
  `).all(user_id);

  const withClub = rows.map(r => {
    const club = db.prepare(`
      SELECT bc.name FROM club_books cb
      JOIN book_clubs bc ON bc.id = cb.club_id
      JOIN club_members cm ON cm.club_id = cb.club_id
      WHERE cb.book_id = ? AND cm.user_id = ?
      LIMIT 1
    `).get(r.book_id, user_id);
    return { ...r, club_name: club ? club.name : null };
  });

  res.json(withClub);
});

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Average publication year across the user's finished books — used to bias
// recommendations toward books from roughly the same era as what they
// actually read, instead of whatever Open Library happens to surface first
// (which tends to be old, heavily-catalogued classics).
function averageReadYear(user_id) {
  const rows = db.prepare(`
    SELECT b.published_year FROM user_books ub JOIN books b ON b.id = ub.book_id
    WHERE ub.user_id = ? AND ub.status = 'leido' AND b.published_year IS NOT NULL
  `).all(user_id);
  if (!rows.length) return null;
  return Math.round(rows.reduce((sum, r) => sum + r.published_year, 0) / rows.length);
}

// Shared helper: pulls books tagged with a given subject/genre from Open
// Library's subjects API (real category data, not a text search), optionally
// filtering out titles the user already owns. When preferredYear is given,
// results lean toward books published near that year without abandoning
// variety entirely: most slots go to close-year matches, the rest are a
// shuffled sample from the wider pool (including books with no known year).
async function fetchSubjectBooks(subjectName, excludeTitles, limit, preferredYear) {
  const targetLimit = limit || 8;
  const slug = subjectName.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '_');
  const r = await fetchWithTimeout(`https://openlibrary.org/subjects/${encodeURIComponent(slug)}.json?limit=${targetLimit * 5}`, 5000);
  if (!r.ok) return [];
  const data = await r.json();
  const candidates = (data.works || [])
    .filter(w => !excludeTitles || !excludeTitles.has((w.title || '').toLowerCase()));

  let selected;
  if (preferredYear) {
    const withYear = candidates.filter(w => w.first_publish_year);
    const withoutYear = candidates.filter(w => !w.first_publish_year);
    withYear.sort((a, b) => Math.abs(a.first_publish_year - preferredYear) - Math.abs(b.first_publish_year - preferredYear));

    const closeCount = Math.min(withYear.length, Math.ceil(targetLimit * 0.6));
    const close = withYear.slice(0, closeCount);
    const rest = shuffleArray([...withYear.slice(closeCount), ...withoutYear]);
    selected = shuffleArray([...close, ...rest.slice(0, Math.max(0, targetLimit - close.length))]);
  } else {
    selected = candidates.slice(0, targetLimit);
  }

  return selected.slice(0, targetLimit).map(w => ({
    api_id: `ol-${w.key}`,
    isbn: null,
    title: w.title,
    authors: (w.authors || []).map(a => a.name).join(', '),
    cover_url: w.cover_id ? `https://covers.openlibrary.org/b/id/${w.cover_id}-M.jpg` : null,
    pages: null,
    published_year: w.first_publish_year || null,
    categories: subjectName,
    language: null
  }));
}

// Recommendations: looks at the user's top genre (from books they've read)
// and pulls popular books in that subject from Open Library, filtering out
// anything already in the user's library.
app.get('/api/recommendations', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const stats = computeStats(user_id);
  const topGenre = stats.top_generos[0]?.[0];
  if (!topGenre) return res.json({ subject: null, books: [] });

  const alreadyOwned = new Set(
    db.prepare(`
      SELECT LOWER(b.title) as t FROM user_books ub JOIN books b ON b.id = ub.book_id WHERE ub.user_id = ?
    `).all(user_id).map(r => r.t)
  );

  try {
    const preferredYear = averageReadYear(user_id);
    const books = await fetchSubjectBooks(topGenre, alreadyOwned, 8, preferredYear);
    res.json({ subject: topGenre, books });
  } catch (err) {
    console.error('Recommendations lookup failed:', err.message);
    res.json({ subject: topGenre, books: [] });
  }
});

// Browse by category: real subject-tagged results (Open Library subjects
// API), used by the quick category chips in the search tab — not a text
// search of the category name against titles. user_id is optional so the
// same endpoint still works if it's ever called without one, but when
// present it leans results toward the user's usual publication era.
app.get('/api/browse', async (req, res) => {
  const { category, user_id } = req.query;
  if (!category) return res.status(400).json({ error: 'category is required' });
  try {
    const preferredYear = user_id ? averageReadYear(user_id) : null;
    const books = await fetchSubjectBooks(category, null, 20, preferredYear);
    res.json(books);
  } catch (err) {
    console.error('Browse by category failed:', err.message);
    res.status(502).json({ error: 'Could not reach Open Library. Check the server terminal for details.' });
  }
});

// Comparativa social: solo entre contactos aceptados
app.get('/api/compare', (req, res) => {
  const { user_id, contact_user_id } = req.query;
  if (!user_id || !contact_user_id) return res.status(400).json({ error: 'user_id and contact_user_id are required' });

  const isContact = db.prepare(`
    SELECT 1 FROM contacts WHERE user_id = ? AND contact_user_id = ? AND status = 'aceptado'
  `).get(user_id, contact_user_id);
  if (!isContact) return res.status(403).json({ error: 'You can only compare with accepted contacts' });

  const meLibros = db.prepare(`SELECT book_id FROM user_books WHERE user_id = ? AND status = 'leido'`).all(user_id).map(r => r.book_id);
  const contactoLibros = db.prepare(`SELECT book_id FROM user_books WHERE user_id = ? AND status = 'leido'`).all(contact_user_id).map(r => r.book_id);
  const enComun = meLibros.filter(id => contactoLibros.includes(id));
  const comunInfo = enComun.length
    ? db.prepare(`SELECT id, title FROM books WHERE id IN (${enComun.map(() => '?').join(',')})`).all(...enComun)
    : [];

  res.json({
    yo: computeStats(user_id),
    contacto: computeStats(contact_user_id),
    libros_en_comun: comunInfo
  });
});

// Feed de actividad: lo que tus contactos aceptados han leído/marcado
// recientemente. Solo mira contactos aceptados, nunca a toda la base de usuarios.
app.get('/api/feed', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const contactIds = db.prepare(`
    SELECT contact_user_id FROM contacts WHERE user_id = ? AND status = 'aceptado'
  `).all(user_id).map(r => r.contact_user_id);

  if (!contactIds.length) return res.json([]);

  const placeholders = contactIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT ub.id, ub.status, ub.rating, ub.updated_at, ub.end_date, ub.start_date,
           u.id as user_id, u.name as user_name, u.username, u.avatar_seed,
           b.title, b.authors, b.cover_url, b.pages, b.categories
    FROM user_books ub
    JOIN users u ON u.id = ub.user_id
    JOIN books b ON b.id = ub.book_id
    WHERE ub.user_id IN (${placeholders}) AND ub.status IN ('leido', 'leyendo')
    ORDER BY ub.updated_at DESC
    LIMIT 30
  `).all(...contactIds);

  res.json(rows);
});

// ---------- Book Clubs ----------
// Anyone can create a club and be found by name so contacts can join
// directly (no approval step, mirroring how the user described it). Only
// the owner can rename/describe the club, add/remove members, manage the
// reading list, and set/remove weekly goals. Every member tracks their own
// completion of each weekly goal so the group can see who's on pace.

function isClubMember(clubId, userId) {
  return !!db.prepare('SELECT 1 FROM club_members WHERE club_id = ? AND user_id = ?').get(clubId, userId);
}
function isClubOwner(clubId, userId) {
  const club = db.prepare('SELECT owner_user_id FROM book_clubs WHERE id = ?').get(clubId);
  return !!club && String(club.owner_user_id) === String(userId);
}

// When a club's book becomes the current read, every member's own library
// should reflect "reading" with a start date; when it's marked finished,
// it should flip to "read" with an end date — without clobbering anyone who
// already finished it (or started it) on their own before the club did.
function syncClubBookToMemberLibraries(clubId, bookId, targetStatus, memberIds) {
  const today = new Date().toISOString().slice(0, 10);
  const members = memberIds || db.prepare('SELECT user_id FROM club_members WHERE club_id = ?').all(clubId).map(r => r.user_id);

  for (const userId of members) {
    const existing = db.prepare('SELECT * FROM user_books WHERE user_id = ? AND book_id = ?').get(userId, bookId);

    if (targetStatus === 'leyendo') {
      if (!existing) {
        db.prepare(`
          INSERT INTO user_books (user_id, book_id, status, start_date) VALUES (?, ?, 'leyendo', ?)
        `).run(userId, bookId, today);
      } else if (existing.status === 'por_leer') {
        db.prepare(`
          UPDATE user_books SET status = 'leyendo', start_date = COALESCE(start_date, ?) WHERE id = ?
        `).run(today, existing.id);
      }
      // Already 'leyendo' or 'leido' on their own — leave it as-is.
    } else if (targetStatus === 'leido') {
      if (!existing) {
        db.prepare(`
          INSERT INTO user_books (user_id, book_id, status, start_date, end_date) VALUES (?, ?, 'leido', ?, ?)
        `).run(userId, bookId, today, today);
      } else if (existing.status !== 'leido') {
        db.prepare(`
          UPDATE user_books SET status = 'leido', start_date = COALESCE(start_date, ?), end_date = ? WHERE id = ?
        `).run(today, today, existing.id);
      }
      // Already 'leido' — leave their own rating/dates untouched.
    }
  }
}

app.post('/api/clubs', (req, res) => {
  const { user_id, name, description } = req.body;
  if (!user_id || !name || !name.trim()) return res.status(400).json({ error: 'user_id and name are required' });

  const existing = db.prepare('SELECT id FROM book_clubs WHERE LOWER(name) = LOWER(?)').get(name.trim());
  if (existing) return res.status(409).json({ error: 'A club with that name already exists' });

  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      INSERT INTO book_clubs (name, description, owner_user_id) VALUES (?, ?, ?)
    `).run(name.trim(), description || null, user_id);
    db.prepare(`
      INSERT INTO club_members (club_id, user_id, role) VALUES (?, ?, 'owner')
    `).run(info.lastInsertRowid, user_id);
    db.exec('COMMIT');
    res.json(db.prepare('SELECT * FROM book_clubs WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// Search clubs by (partial) name — how contacts find a club to join.
app.get('/api/clubs/search', (req, res) => {
  const { q, user_id } = req.query;
  if (!q || !q.trim()) return res.json([]);
  const rows = db.prepare(`
    SELECT bc.*, (SELECT COUNT(*) FROM club_members cm WHERE cm.club_id = bc.id) as member_count
    FROM book_clubs bc
    WHERE bc.name LIKE ?
    LIMIT 20
  `).all(`%${q.trim()}%`);
  const withMembership = rows.map(c => ({
    ...c,
    is_member: user_id ? isClubMember(c.id, user_id) : false
  }));
  res.json(withMembership);
});

// Clubs the user already belongs to.
app.get('/api/clubs', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  const rows = db.prepare(`
    SELECT bc.*, cm.role,
           (SELECT COUNT(*) FROM club_members cm2 WHERE cm2.club_id = bc.id) as member_count
    FROM club_members cm
    JOIN book_clubs bc ON bc.id = cm.club_id
    WHERE cm.user_id = ?
    ORDER BY bc.created_at DESC
  `).all(user_id);
  res.json(rows);
});

app.post('/api/clubs/:id/join', (req, res) => {
  const { user_id } = req.body;
  const club = db.prepare('SELECT id FROM book_clubs WHERE id = ?').get(req.params.id);
  if (!club) return res.status(404).json({ error: 'Club not found' });
  if (isClubMember(club.id, user_id)) return res.status(409).json({ error: 'You are already a member of this club' });
  db.prepare(`INSERT INTO club_members (club_id, user_id, role) VALUES (?, ?, 'member')`).run(club.id, user_id);

  // If the club is already mid-book, the new member should see it as
  // "reading" in their own library right away, same as everyone else.
  const currentBook = db.prepare(`SELECT book_id FROM club_books WHERE club_id = ? AND status = 'current'`).get(club.id);
  if (currentBook) syncClubBookToMemberLibraries(club.id, currentBook.book_id, 'leyendo', [user_id]);

  res.json({ ok: true });
});

app.post('/api/clubs/:id/leave', (req, res) => {
  const { user_id } = req.body;
  if (isClubOwner(req.params.id, user_id)) {
    return res.status(400).json({ error: 'The owner cannot leave — delete the club instead' });
  }
  db.prepare('DELETE FROM club_members WHERE club_id = ? AND user_id = ?').run(req.params.id, user_id);
  res.json({ ok: true });
});

app.patch('/api/clubs/:id', (req, res) => {
  const { user_id, name, description } = req.body;
  if (!isClubOwner(req.params.id, user_id)) return res.status(403).json({ error: 'Only the club owner can edit it' });
  if (name && name.trim()) {
    const clash = db.prepare('SELECT id FROM book_clubs WHERE LOWER(name) = LOWER(?) AND id != ?').get(name.trim(), req.params.id);
    if (clash) return res.status(409).json({ error: 'A club with that name already exists' });
  }
  db.prepare(`
    UPDATE book_clubs SET name = COALESCE(?, name), description = ? WHERE id = ?
  `).run(name && name.trim() ? name.trim() : null, description ?? null, req.params.id);
  res.json(db.prepare('SELECT * FROM book_clubs WHERE id = ?').get(req.params.id));
});

app.delete('/api/clubs/:id', (req, res) => {
  const { user_id } = req.body;
  if (!isClubOwner(req.params.id, user_id)) return res.status(403).json({ error: 'Only the club owner can delete it' });
  db.prepare('DELETE FROM book_clubs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/clubs/:id/members/:memberId', (req, res) => {
  const { user_id } = req.body;
  if (!isClubOwner(req.params.id, user_id)) return res.status(403).json({ error: 'Only the club owner can remove members' });
  if (String(req.params.memberId) === String(user_id)) return res.status(400).json({ error: 'The owner cannot remove themself — delete the club instead' });
  db.prepare('DELETE FROM club_members WHERE club_id = ? AND user_id = ?').run(req.params.id, req.params.memberId);
  res.json({ ok: true });
});

// Full club detail: members, reading list, and weekly goals with each
// member's completion — everything the club view needs in one call.
app.get('/api/clubs/:id', (req, res) => {
  const { user_id } = req.query;
  const club = db.prepare('SELECT * FROM book_clubs WHERE id = ?').get(req.params.id);
  if (!club) return res.status(404).json({ error: 'Club not found' });
  if (!user_id || !isClubMember(club.id, user_id)) return res.status(403).json({ error: 'You are not a member of this club' });

  const members = db.prepare(`
    SELECT u.id, u.name, u.username, u.avatar_seed, cm.role, cm.joined_at
    FROM club_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.club_id = ?
    ORDER BY cm.role DESC, cm.joined_at ASC
  `).all(club.id);

  const books = db.prepare(`
    SELECT cb.id as club_book_id, cb.status, cb.created_at, b.*
    FROM club_books cb JOIN books b ON b.id = cb.book_id
    WHERE cb.club_id = ?
    ORDER BY (cb.status = 'current') DESC, cb.created_at DESC
  `).all(club.id);

  const goalRows = db.prepare(`
    SELECT cg.*, cb.book_id
    FROM club_goals cg LEFT JOIN club_books cb ON cb.id = cg.club_book_id
    WHERE cg.club_id = ?
    ORDER BY cg.week_start DESC, cg.created_at DESC
  `).all(club.id);

  const goals = goalRows.map(g => {
    const bookTitle = g.book_id ? db.prepare('SELECT title FROM books WHERE id = ?').get(g.book_id)?.title : null;
    const progressRows = db.prepare('SELECT user_id, completed_at FROM club_goal_progress WHERE goal_id = ?').all(g.id);
    const completedIds = new Set(progressRows.map(p => p.user_id));
    const memberStatus = members.map(m => ({
      user_id: m.id,
      name: m.name,
      avatar_seed: m.avatar_seed,
      completed: completedIds.has(m.id)
    }));
    return {
      id: g.id,
      club_book_id: g.club_book_id,
      book_title: bookTitle,
      description: g.description,
      week_start: g.week_start,
      members: memberStatus,
      completed_count: memberStatus.filter(m => m.completed).length,
      total_members: memberStatus.length
    };
  });

  res.json({ ...club, my_role: members.find(m => m.id === Number(user_id))?.role || null, members, books, goals });
});

// Add a book to the club's reading list — used from the search tab's
// "club mode" (findOrCreateBook keeps the shared catalog in sync).
app.post('/api/clubs/:id/books', async (req, res) => {
  const { user_id, book, status } = req.body;
  if (!isClubOwner(req.params.id, user_id)) return res.status(403).json({ error: 'Only the club owner can add books' });
  if (!book) return res.status(400).json({ error: 'book is required' });
  book.api_id = book.api_id || `manual-${book.isbn || book.title}`;
  await enrichBook(book);
  const bookRow = findOrCreateBook(book);

  const desiredStatus = status === 'current' ? 'current' : 'upcoming';
  if (desiredStatus === 'current') {
    db.prepare(`UPDATE club_books SET status = 'upcoming' WHERE club_id = ? AND status = 'current'`).run(req.params.id);
  }
  db.prepare(`
    INSERT INTO club_books (club_id, book_id, status, added_by) VALUES (?, ?, ?, ?)
  `).run(req.params.id, bookRow.id, desiredStatus, user_id);

  // Added straight in as the current book: reflect "reading" in every
  // member's own library right away.
  if (desiredStatus === 'current') syncClubBookToMemberLibraries(req.params.id, bookRow.id, 'leyendo');

  res.json({ ok: true });
});

app.patch('/api/clubs/:id/books/:clubBookId', (req, res) => {
  const { user_id, status } = req.body;
  if (!isClubOwner(req.params.id, user_id)) return res.status(403).json({ error: 'Only the club owner can update the reading list' });
  if (!['current', 'upcoming', 'done'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const clubBook = db.prepare('SELECT * FROM club_books WHERE id = ? AND club_id = ?').get(req.params.clubBookId, req.params.id);
  if (!clubBook) return res.status(404).json({ error: 'Book not found in this club' });

  if (status === 'current') {
    db.prepare(`UPDATE club_books SET status = 'upcoming' WHERE club_id = ? AND status = 'current'`).run(req.params.id);
  }
  db.prepare('UPDATE club_books SET status = ? WHERE id = ? AND club_id = ?').run(status, req.params.clubBookId, req.params.id);

  // Mirror the change into every member's personal library: start reading
  // when it becomes current, mark it read (with an end date) once finished.
  if (status === 'current') syncClubBookToMemberLibraries(req.params.id, clubBook.book_id, 'leyendo');
  if (status === 'done') syncClubBookToMemberLibraries(req.params.id, clubBook.book_id, 'leido');

  res.json({ ok: true });
});

app.delete('/api/clubs/:id/books/:clubBookId', (req, res) => {
  const { user_id } = req.body;
  if (!isClubOwner(req.params.id, user_id)) return res.status(403).json({ error: 'Only the club owner can update the reading list' });
  const clubBook = db.prepare('SELECT * FROM club_books WHERE id = ? AND club_id = ?').get(req.params.clubBookId, req.params.id);
  if (!clubBook) return res.status(404).json({ error: 'Book not found in this club' });

  // Weekly goals tied to this book stop making sense once it's gone.
  db.prepare('DELETE FROM club_goals WHERE club_book_id = ?').run(req.params.clubBookId);

  // It was only in members' libraries because the club picked it, so take it
  // back out of everyone's library too when it's removed from the club.
  const memberIds = db.prepare('SELECT user_id FROM club_members WHERE club_id = ?').all(req.params.id).map(r => r.user_id);
  if (memberIds.length) {
    const placeholders = memberIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM user_books WHERE book_id = ? AND user_id IN (${placeholders})`).run(clubBook.book_id, ...memberIds);
  }

  db.prepare('DELETE FROM club_books WHERE id = ? AND club_id = ?').run(req.params.clubBookId, req.params.id);
  res.json({ ok: true });
});

app.post('/api/clubs/:id/goals', (req, res) => {
  const { user_id, club_book_id, description, week_start } = req.body;
  if (!isClubOwner(req.params.id, user_id)) return res.status(403).json({ error: 'Only the club owner can set weekly goals' });
  if (!description || !description.trim() || !week_start) return res.status(400).json({ error: 'description and week_start are required' });

  const info = db.prepare(`
    INSERT INTO club_goals (club_id, club_book_id, description, week_start, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, club_book_id || null, description.trim(), week_start, user_id);
  res.json({ id: info.lastInsertRowid, ok: true });
});

app.delete('/api/clubs/:id/goals/:goalId', (req, res) => {
  const { user_id } = req.body;
  if (!isClubOwner(req.params.id, user_id)) return res.status(403).json({ error: 'Only the club owner can remove weekly goals' });
  db.prepare('DELETE FROM club_goals WHERE id = ? AND club_id = ?').run(req.params.goalId, req.params.id);
  res.json({ ok: true });
});

// Each member marks their own progress — toggled independently of everyone else.
app.post('/api/clubs/:id/goals/:goalId/complete', (req, res) => {
  const { user_id } = req.body;
  if (!isClubMember(req.params.id, user_id)) return res.status(403).json({ error: 'You are not a member of this club' });
  db.prepare(`
    INSERT OR IGNORE INTO club_goal_progress (goal_id, user_id) VALUES (?, ?)
  `).run(req.params.goalId, user_id);
  res.json({ ok: true });
});

app.delete('/api/clubs/:id/goals/:goalId/complete', (req, res) => {
  const { user_id } = req.body;
  db.prepare('DELETE FROM club_goal_progress WHERE goal_id = ? AND user_id = ?').run(req.params.goalId, user_id);
  res.json({ ok: true });
});

// ---------- Achievements ----------
// Computed on the fly from stats + contacts + invites, no separate table to
// keep in sync — badges just reflect whatever is true right now. Grouped
// into categories, each ordered from easiest to hardest, with several that
// are intentionally slow/hard to reach so the full set doesn't fill up fast.
app.get('/api/achievements', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const stats = computeStats(user_id);
  const contactCount = db.prepare(`SELECT COUNT(*) as c FROM contacts WHERE user_id = ? AND status = 'aceptado'`).get(user_id).c;
  const genreCount = stats.top_generos.length;
  const yearGoalMet = stats.meta_anual && stats.leidos_este_anio >= stats.meta_anual;
  const overachiever = stats.meta_anual && stats.leidos_este_anio >= stats.meta_anual * 1.5;

  const recruitedCount = db.prepare(`
    SELECT COUNT(*) as c FROM invites WHERE created_by = ? AND used_by IS NOT NULL
  `).get(user_id).c;

  const ratedCount = db.prepare(`
    SELECT COUNT(*) as c FROM user_books WHERE user_id = ? AND status = 'leido' AND rating IS NOT NULL
  `).get(user_id).c;

  const user = db.prepare('SELECT created_at FROM users WHERE id = ?').get(user_id);
  const accountDays = user ? Math.floor((Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24)) : 0;

  const categories = [
    {
      id: 'milestones',
      label: 'Reading Milestones',
      badges: [
        { id: 'first_book', icon: '📖', label: 'First Page', description: 'Finish your first book', achieved: stats.total_leidos >= 1 },
        { id: 'five_books', icon: '📚', label: 'Bookworm', description: 'Read 5 books', achieved: stats.total_leidos >= 5 },
        { id: 'ten_books', icon: '🏆', label: 'Dedicated Reader', description: 'Read 10 books', achieved: stats.total_leidos >= 10 },
        { id: 'twenty_five_books', icon: '👑', label: 'Bibliophile', description: 'Read 25 books', achieved: stats.total_leidos >= 25 },
        { id: 'fifty_books', icon: '💯', label: 'Century Club', description: 'Read 50 books', achieved: stats.total_leidos >= 50 },
        { id: 'hundred_books', icon: '🌟', label: 'Legendary Reader', description: 'Read 100 books', achieved: stats.total_leidos >= 100 }
      ]
    },
    {
      id: 'pages',
      label: 'Pages',
      badges: [
        { id: 'page_turner', icon: '📄', label: 'Page Turner', description: 'Read 1,000+ pages total', achieved: stats.total_paginas >= 1000 },
        { id: 'page_devourer', icon: '📰', label: 'Page Devourer', description: 'Read 2,500+ pages total', achieved: stats.total_paginas >= 2500 },
        { id: 'marathon_reader', icon: '🏃', label: 'Marathon Reader', description: 'Read 5,000+ pages total', achieved: stats.total_paginas >= 5000 },
        { id: 'page_titan', icon: '🗻', label: 'Page Titan', description: 'Read 10,000+ pages total', achieved: stats.total_paginas >= 10000 }
      ]
    },
    {
      id: 'variety',
      label: 'Variety',
      badges: [
        { id: 'genre_explorer', icon: '🧭', label: 'Genre Explorer', description: 'Read books across 3+ different genres', achieved: genreCount >= 3 },
        { id: 'genre_connoisseur', icon: '🎭', label: 'Genre Connoisseur', description: 'Read books across 6+ different genres', achieved: genreCount >= 6 },
        { id: 'genre_master', icon: '🌈', label: 'Genre Master', description: 'Read books across 10+ different genres', achieved: genreCount >= 10 }
      ]
    },
    {
      id: 'goals',
      label: 'Goals & Discipline',
      badges: [
        { id: 'goal_setter', icon: '🎯', label: 'Goal Setter', description: 'Set a yearly reading goal', achieved: !!stats.meta_anual },
        { id: 'goal_crusher', icon: '🏅', label: 'Goal Crusher', description: 'Hit your yearly reading goal', achieved: !!yearGoalMet },
        { id: 'overachiever', icon: '🚀', label: 'Overachiever', description: 'Beat your yearly goal by 50%', achieved: !!overachiever },
        { id: 'speed_reader', icon: '⚡', label: 'Speed Reader', description: 'Finish a book in 3 days or less', achieved: stats.lectura_mas_rapida_dias != null && stats.lectura_mas_rapida_dias <= 3 },
        { id: 'big_book', icon: '🧱', label: 'Heavy Lifter', description: 'Finish a book with 500+ pages', achieved: stats.max_paginas_libro >= 500 }
      ]
    },
    {
      id: 'consistency',
      label: 'Consistency',
      badges: [
        { id: 'on_a_roll', icon: '🔥', label: 'On a Roll', description: 'Finish books in 2 consecutive months', achieved: stats.meses_consecutivos >= 2 },
        { id: 'consistent_reader', icon: '🔥', label: 'Consistent Reader', description: 'Finish books in 4 consecutive months', achieved: stats.meses_consecutivos >= 4 },
        { id: 'unstoppable', icon: '🔥', label: 'Unstoppable', description: 'Finish books in 6 consecutive months', achieved: stats.meses_consecutivos >= 6 },
        { id: 'one_year_strong', icon: '🎂', label: 'One Year Strong', description: 'Be a ReadTrack member for 365+ days', achieved: accountDays >= 365 }
      ]
    },
    {
      id: 'curation',
      label: 'Library Curation',
      badges: [
        { id: 'curator', icon: '🗂️', label: 'Curator', description: 'Add 10 books to your library (any status)', achieved: stats.total_libros_biblioteca >= 10 },
        { id: 'collector', icon: '📦', label: 'Collector', description: 'Add 25 books to your library (any status)', achieved: stats.total_libros_biblioteca >= 25 },
        { id: 'archivist', icon: '🏛️', label: 'Archivist', description: 'Add 50 books to your library (any status)', achieved: stats.total_libros_biblioteca >= 50 }
      ]
    },
    {
      id: 'social',
      label: 'Social',
      badges: [
        { id: 'first_friend', icon: '🤝', label: 'First Friend', description: 'Add your first contact', achieved: contactCount >= 1 },
        { id: 'social_butterfly', icon: '🦋', label: 'Social Butterfly', description: 'Add 3+ contacts', achieved: contactCount >= 3 },
        { id: 'community_builder', icon: '🌐', label: 'Community Builder', description: 'Add 10+ contacts', achieved: contactCount >= 10 },
        { id: 'recruiter', icon: '✉️', label: 'Recruiter', description: 'Invite a friend who joins ReadTrack', achieved: recruitedCount >= 1 }
      ]
    },
    {
      id: 'taste',
      label: 'Taste',
      badges: [
        { id: 'critic', icon: '⭐', label: 'Critic', description: 'Rate 5 books', achieved: ratedCount >= 5 },
        { id: 'five_star_fan', icon: '🌟', label: 'Five-Star Fan', description: 'Give 5 books a 5-star rating', achieved: stats.rating_5_count >= 5 }
      ]
    }
  ];

  res.json(categories);
});

const PORT = process.env.PORT || 3300;
app.listen(PORT, () => console.log(`ReadTrack corriendo en http://localhost:${PORT}`));
