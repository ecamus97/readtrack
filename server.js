const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { requireAuth } = require('./auth');

// Manual .env loader (no dependency needed), so secrets don't have to be
// exported by hand every time the server starts. See README for details.
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

// Express 4 doesn't catch rejected promises from `async (req, res) => {...}`
// handlers on its own — an unhandled rejection there used to just hang the
// request forever (or, worse, crash the whole Node process on a transient
// DB hiccup, taking down every other in-flight request with it). Wrapping
// every app.get/post/etc call here means a single failed request always
// turns into a normal JSON 500 via the error-handling middleware at the
// bottom of this file, instead of an outage.
for (const method of ['get', 'post', 'patch', 'delete', 'put']) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => original(routePath, ...handlers.map(h =>
    h.length >= 4 // (err, req, res, next) — an error handler, leave it alone
      ? h
      : async (req, res, next) => { try { await h(req, res, next); } catch (err) { next(err); } }
  ));
}

app.use(express.json());
// Cache-Control: no-cache doesn't mean "don't cache" — it means "always ask
// the server whether this file changed before using the cached copy"
// (a fast, cheap check via ETag/Last-Modified, not a full re-download). This
// was missing before, so mobile Safari in particular could keep serving a
// stale styles.css/app.js for a long time after a deploy with no visible
// sign anything was wrong, which is a serious problem while we're actively
// iterating on CSS.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

// Unauthenticated, does nothing but confirm the process is up — point an
// uptime pinger (e.g. UptimeRobot) here every few minutes so Render's free
// tier doesn't spin the service down between visits.
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

// Every /api/* route requires a valid Supabase session from here on — the
// server figures out who's asking from the verified token (req.userId),
// it never trusts a user_id the client sends. This is the core change from
// the local-prototype version, where anyone could pass any user_id.
app.use('/api', requireAuth);

// ---------- Profile ----------
// Profiles are auto-created by a Postgres trigger the moment someone signs
// up via Supabase Auth (see schema.sql), so there's no "create user" endpoint
// here anymore — only read/update your own profile.

app.get('/api/profile', async (req, res) => {
  const profile = await db.get('SELECT id, name, username, avatar_seed, created_at FROM profiles WHERE id = ?', [req.userId]);
  if (!profile) return res.status(404).json({ error: 'Profile not found yet — try again in a moment' });
  res.json(profile);
});

app.patch('/api/profile', async (req, res) => {
  const { name, username, avatar_seed } = req.body;
  const fields = [];
  const values = [];
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (username !== undefined) { fields.push('username = ?'); values.push(username || null); }
  if (avatar_seed !== undefined) { fields.push('avatar_seed = ?'); values.push(avatar_seed); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.userId);
  try {
    await db.run(`UPDATE profiles SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ ok: true });
  } catch (err) {
    if (String(err).includes('unique')) return res.status(409).json({ error: 'That username is already taken' });
    throw err;
  }
});

// Looks up ANY profile by its unique username — used when sending a contact
// request by username instead of picking from a list of every user.
app.get('/api/profiles/lookup', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username is required' });
  const user = await db.get('SELECT id, name, username FROM profiles WHERE username = ?', [username]);
  if (!user) return res.status(404).json({ error: 'No user found with that username' });
  res.json(user);
});

// ---------- Book search (Google Books API) ----------

function withGoogleKey(url) {
  return GOOGLE_BOOKS_API_KEY ? `${url}&key=${GOOGLE_BOOKS_API_KEY}` : url;
}

function mapGoogleBooksItem(item) {
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
    language: info.language || null,
    description: info.description || null
  };
}

// Plain `q=<text>` full-text search against Google Books' whole corpus
// (which also matches inside descriptions/blurbs, not just title/author) is
// why some searches surfaced books with nothing obviously to do with what
// was typed. No timeout on the fetch call also meant a slow/hung request
// could make a search silently take forever rather than fail fast into the
// OpenLibrary fallback below.
async function fetchGoogleBooksQuery(q) {
  const url = withGoogleKey(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=12`);
  try {
    const r = await fetchWithTimeout(url, OL_TIMEOUT);
    const data = await r.json();
    if (!r.ok || data.error) {
      console.error('Google Books returned an error:', r.status, JSON.stringify(data.error || data));
      return null;
    }
    return (data.items || []).map(mapGoogleBooksItem);
  } catch (err) {
    console.error('Google Books call failed:', err.message);
    return null;
  }
}

async function searchGoogleBooks(q) {
  // Search title and author as separate, field-scoped queries (Google's
  // intitle:/inauthor: qualifiers) so results are actually about what the
  // user typed, instead of one loose full-text query that can match
  // anywhere in the record. Title matches are listed first (more specific
  // signal), then author matches not already included.
  const [titleHits, authorHits] = await Promise.all([
    fetchGoogleBooksQuery(`intitle:${q}`),
    fetchGoogleBooksQuery(`inauthor:${q}`)
  ]);
  if (titleHits === null && authorHits === null) return null; // both requests actually failed — let the caller fall back to OpenLibrary

  const seen = new Set();
  const merged = [];
  for (const b of [...(titleHits || []), ...(authorHits || [])]) {
    if (seen.has(b.api_id)) continue;
    seen.add(b.api_id);
    merged.push(b);
  }
  if (merged.length) return merged;

  // Neither a title- nor author-scoped match found anything — the query
  // might be a series name, a subtitle fragment, or otherwise not a clean
  // title/author match. A loosely-relevant plain search beats no results.
  return await fetchGoogleBooksQuery(q);
}

async function searchOpenLibrary(q) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=12&fields=key,title,author_name,cover_i,isbn,number_of_pages_median,first_publish_year,subject,language`;
  try {
    const r = await fetchWithTimeout(url, OL_TIMEOUT);
    if (!r.ok) {
      console.error('Open Library returned an error:', r.status);
      return null;
    }
    const data = await r.json();
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
  } catch (err) {
    console.error('Open Library call failed:', err.message);
    return null;
  }
}

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q is required' });

  let results = await searchGoogleBooks(q);
  let fallback = null;

  if (!results || results.length === 0) {
    fallback = await searchOpenLibrary(q);
    if (fallback && fallback.length) results = fallback;
  }

  if (results === null && fallback === null) {
    return res.status(502).json({ error: 'Could not reach any book API. Check the server logs for details.' });
  }

  res.json(results || []);
});

// Retries default to 0 now — with the longer OL_TIMEOUT below, a retry on
// top would let a single slow OpenLibrary call cost 40+ seconds (timeout,
// then a full second timeout again), which is worse for the user than one
// patient attempt. Callers that specifically want a retry (e.g. a quick,
// small lookup) can still pass a higher `retries` explicitly.
async function fetchWithTimeout(url, ms, retries = 0) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 300));
    } finally {
      clearTimeout(timer);
    }
  }
}

// Render's logs showed OpenLibrary calls consistently timing out ("This
// operation was aborted") at the old 8s timeout across many separate
// requests over several minutes — not a one-off blip. Fetching the same
// OpenLibrary endpoints directly (outside Render) worked fine and quickly,
// so this looks like OpenLibrary responding noticeably slower to Render's
// network specifically, rather than being down outright. A longer timeout
// gives those slow-but-real responses a chance to actually come back
// instead of aborting into an empty result every time.
const OL_TIMEOUT = 20000;

// Tries several sources in order to fill in missing pages/categories/
// description. Open Library goes first (no quota); Google Books is a
// last-resort bonus since its free quota without an API key runs out fast.
async function enrichBook(book) {
  if (book.pages && book.categories && book.description) return book;
  console.log(`[enrich] "${book.title}" — missing: ${!book.pages ? 'pages ' : ''}${!book.categories ? 'categories ' : ''}${!book.description ? 'description' : ''}`);

  let workKey = null;

  if ((!book.pages || !book.categories) && book.title) {
    try {
      const params = new URLSearchParams({ title: book.title, limit: '1' });
      if (book.authors) params.set('author', book.authors.split(',')[0].trim());
      const r = await fetchWithTimeout(`https://openlibrary.org/search.json?${params.toString()}`, OL_TIMEOUT);
      if (r.ok) {
        const data = await r.json();
        const doc = data.docs?.[0];
        if (doc) {
          if (!book.isbn && doc.isbn?.[0]) book.isbn = doc.isbn[0];
          if (!book.pages && doc.number_of_pages_median) book.pages = doc.number_of_pages_median;
          if (!book.categories && doc.subject?.length) book.categories = doc.subject.slice(0, 3).join(', ');
          workKey = doc.key || null;
        }
      }
    } catch (err) {
      console.error('[enrich]   Open Library (search) failed:', err.message);
    }
  }

  if (book.isbn && (!book.pages || !book.categories)) {
    try {
      const r = await fetchWithTimeout(`https://openlibrary.org/isbn/${book.isbn}.json`, OL_TIMEOUT);
      if (r.ok) {
        const data = await r.json();
        if (!book.pages && data.number_of_pages) book.pages = data.number_of_pages;
        if (!book.categories && Array.isArray(data.subjects) && data.subjects.length) {
          book.categories = data.subjects.slice(0, 3).join(', ');
        }
        workKey = workKey || data.works?.[0]?.key || null;
      }
    } catch (err) {
      console.error('[enrich]   Open Library (isbn) failed:', err.message);
    }
  }

  if (!book.categories && workKey) {
    try {
      const r = await fetchWithTimeout(`https://openlibrary.org${workKey}.json`, OL_TIMEOUT);
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data.subjects) && data.subjects.length) {
          book.categories = data.subjects.slice(0, 3).join(', ');
        }
      }
    } catch (err) {
      console.error('[enrich]   Open Library (work) failed:', err.message);
    }
  }

  if (!book.pages && workKey) {
    try {
      const r = await fetchWithTimeout(`https://openlibrary.org${workKey}/editions.json?limit=20`, OL_TIMEOUT);
      if (r.ok) {
        const data = await r.json();
        const withPages = (data.entries || []).find(e => e.number_of_pages);
        if (withPages) {
          book.pages = withPages.number_of_pages;
          if (!book.isbn && withPages.isbn_13?.[0]) book.isbn = withPages.isbn_13[0];
        }
      }
    } catch (err) {
      console.error('[enrich]   Open Library (editions) failed:', err.message);
    }
  }

  if (!book.pages || !book.categories || !book.description) {
    try {
      const query = `${book.title} ${book.authors || ''}`.trim();
      const results = await searchGoogleBooks(query);
      const match = results?.[0];
      if (match) {
        if (!book.isbn && match.isbn) book.isbn = match.isbn;
        if (!book.pages && match.pages) book.pages = match.pages;
        if (!book.categories && match.categories) book.categories = match.categories;
        if (!book.description && match.description) book.description = match.description;
      }
    } catch (err) {
      console.error('[enrich]   Google Books failed:', err.message);
    }
  }

  // Google Books' description covers most cases (it's checked first, above),
  // but for older/public-domain titles OpenLibrary's work page sometimes has
  // one when Google doesn't — worth one more try before giving up.
  if (!book.description && workKey) {
    try {
      const r = await fetchWithTimeout(`https://openlibrary.org${workKey}.json`, OL_TIMEOUT);
      if (r.ok) {
        const data = await r.json();
        const desc = typeof data.description === 'string' ? data.description : data.description?.value;
        if (desc) book.description = desc;
      }
    } catch (err) {
      console.error('[enrich]   Open Library (description) failed:', err.message);
    }
  }

  console.log(`[enrich] final result "${book.title}": pages=${book.pages || 'no data'}, categories=${book.categories || 'no data'}, description=${book.description ? 'found' : 'no data'}`);
  return book;
}

app.post('/api/enrich', async (req, res) => {
  const book = { ...req.body };
  await enrichBook(book);
  res.json(book);
});

// ---------- Book catalog ----------

async function findOrCreateBook(b) {
  const existing = await db.get('SELECT * FROM books WHERE api_id = ?', [b.api_id]);
  if (existing) return existing;
  return db.withTransaction(async (tx) => {
    const info = await tx.run(`
      INSERT INTO books (api_id, isbn, title, authors, cover_url, pages, published_year, categories, language, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [b.api_id, b.isbn || null, b.title, b.authors || null, b.cover_url || null, b.pages || null, b.published_year || null, b.categories || null, b.language || null, b.description || null]);
    return tx.get('SELECT * FROM books WHERE id = ?', [info.lastInsertRowid]);
  });
}

app.post('/api/books', async (req, res) => {
  const b = req.body;
  if (!b.title) return res.status(400).json({ error: 'title is required' });
  b.api_id = b.api_id || `manual-${b.isbn || b.title}`;
  await enrichBook(b);
  const book = await findOrCreateBook(b);
  res.json(book);
});

app.post('/api/books/:id/refresh', async (req, res) => {
  const existing = await db.get('SELECT * FROM books WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Book not found' });
  const enriched = await enrichBook({ ...existing });
  await db.run('UPDATE books SET pages = ?, categories = ?, isbn = ?, description = ? WHERE id = ?',
    [enriched.pages || null, enriched.categories || null, enriched.isbn || existing.isbn || null, enriched.description || existing.description || null, existing.id]);
  const updated = await db.get('SELECT * FROM books WHERE id = ?', [existing.id]);
  res.json(updated);
});

// ---------- My library (user_books) ----------

app.post('/api/user-books', async (req, res) => {
  const { book, status, rating, start_date, end_date } = req.body;
  if (!book) return res.status(400).json({ error: 'book is required' });
  book.api_id = book.api_id || `manual-${book.isbn || book.title}`;
  await enrichBook(book);
  const bookRow = await findOrCreateBook(book);
  try {
    const info = await db.run(`
      INSERT INTO user_books (user_id, book_id, status, rating, start_date, end_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [req.userId, bookRow.id, status || 'por_leer', rating || null, start_date || null, end_date || null]);
    res.json({ id: info.lastInsertRowid, book_id: bookRow.id });
  } catch (err) {
    if (String(err).includes('unique')) {
      return res.status(409).json({ error: 'That book is already in your list' });
    }
    throw err;
  }
});

app.get('/api/user-books', async (req, res) => {
  const rows = await db.all(`
    SELECT ub.id, ub.status, ub.rating, ub.notes, ub.start_date, ub.end_date,
           ub.planned_start_date, ub.planned_end_date, ub.progress_percent,
           b.id as book_id, b.title, b.authors, b.cover_url, b.pages, b.published_year, b.categories, b.language, b.description
    FROM user_books ub JOIN books b ON b.id = ub.book_id
    WHERE ub.user_id = ?
    ORDER BY ub.created_at DESC
  `, [req.userId]);
  res.json(rows);
});

// Ownership check shared by every user_books mutation below, so one user can
// never edit or delete another user's library row by guessing an id.
async function loadOwnedUserBook(id, userId) {
  return db.get('SELECT * FROM user_books WHERE id = ? AND user_id = ?', [id, userId]);
}

app.patch('/api/user-books/:id', async (req, res) => {
  const owned = await loadOwnedUserBook(req.params.id, req.userId);
  if (!owned) return res.status(404).json({ error: 'Not found' });

  let { status, rating, notes, start_date, end_date, planned_start_date, planned_end_date, progress_percent } = req.body;

  // Dragging the reading-progress slider to 100% finishes the book — flip it
  // to "read" (with today as the finish date, unless one was already set)
  // instead of making the person separately go change the status too.
  const resultingStatus = status !== undefined ? status : owned.status;
  if (progress_percent === 100 && resultingStatus === 'leyendo' && status === undefined) {
    status = 'leido';
    if (end_date === undefined && !owned.end_date) end_date = new Date().toISOString().slice(0, 10);
  }

  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries({ status, rating, notes, start_date, end_date, planned_start_date, planned_end_date, progress_percent })) {
    if (v !== undefined) { fields.push(`${k} = ?`); values.push(v); }
  }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.params.id);
  await db.run(`UPDATE user_books SET ${fields.join(', ')} WHERE id = ?`, values);
  res.json({ ok: true, autoCompleted: status === 'leido' && resultingStatus === 'leyendo' && progress_percent === 100 });
});

app.delete('/api/user-books/:id', async (req, res) => {
  const owned = await loadOwnedUserBook(req.params.id, req.userId);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  await db.run('DELETE FROM user_books WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ---------- Goals ----------

app.post('/api/goals', async (req, res) => {
  const { year, target_books, monthly_target } = req.body;
  await db.run(`
    INSERT INTO goals (user_id, year, target_books, monthly_target) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, year) DO UPDATE SET
      target_books = excluded.target_books,
      monthly_target = excluded.monthly_target
  `, [req.userId, year, target_books || null, monthly_target || null]);
  res.json({ ok: true });
});

app.get('/api/goals', async (req, res) => {
  const { year } = req.query;
  if (year) {
    const row = await db.get('SELECT year, target_books, monthly_target FROM goals WHERE user_id = ? AND year = ?', [req.userId, year]);
    return res.json(row || null);
  }
  const rows = await db.all('SELECT year, target_books, monthly_target FROM goals WHERE user_id = ? ORDER BY year DESC', [req.userId]);
  res.json(rows);
});

// ---------- Contacts ----------

app.post('/api/contacts', async (req, res) => {
  const { contact_user_id, contact_username } = req.body;
  let targetId = contact_user_id;
  if (!targetId && contact_username) {
    const target = await db.get('SELECT id FROM profiles WHERE username = ?', [contact_username]);
    if (!target) return res.status(404).json({ error: 'No user found with that username' });
    targetId = target.id;
  }
  if (!targetId) return res.status(400).json({ error: 'contact_user_id or contact_username is required' });
  if (targetId === req.userId) return res.status(400).json({ error: "You can't add yourself" });
  await db.run(`
    INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'pendiente')
    ON CONFLICT (user_id, contact_user_id) DO NOTHING
  `, [req.userId, targetId]);
  res.json({ ok: true });
});

app.post('/api/contacts/:id/accept', async (req, res) => {
  // Only the recipient of the request can accept it.
  const row = await db.get('SELECT * FROM contacts WHERE id = ? AND contact_user_id = ?', [req.params.id, req.userId]);
  if (!row) return res.status(404).json({ error: 'not found' });
  await db.run('UPDATE contacts SET status = ? WHERE id = ?', ['aceptado', req.params.id]);
  await db.run(`
    INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'aceptado')
    ON CONFLICT (user_id, contact_user_id) DO UPDATE SET status = 'aceptado'
  `, [row.contact_user_id, row.user_id]);
  res.json({ ok: true });
});

app.get('/api/contacts', async (req, res) => {
  // Accepted contacts + requests I sent that are still pending.
  const rows = await db.all(`
    SELECT c.id, c.status, u.id as contact_user_id, u.name
    FROM contacts c JOIN profiles u ON u.id = c.contact_user_id
    WHERE c.user_id = ?
    ORDER BY c.status DESC, u.name
  `, [req.userId]);
  res.json(rows);
});

app.get('/api/contacts/incoming', async (req, res) => {
  const rows = await db.all(`
    SELECT c.id, u.id as requester_id, u.name
    FROM contacts c JOIN profiles u ON u.id = c.user_id
    WHERE c.contact_user_id = ? AND c.status = 'pendiente'
  `, [req.userId]);
  res.json(rows);
});

app.delete('/api/contacts', async (req, res) => {
  const { contact_user_id } = req.body;
  if (!contact_user_id) return res.status(400).json({ error: 'contact_user_id is required' });
  await db.run(`
    DELETE FROM contacts WHERE (user_id = ? AND contact_user_id = ?) OR (user_id = ? AND contact_user_id = ?)
  `, [req.userId, contact_user_id, contact_user_id, req.userId]);
  res.json({ ok: true });
});

// ---------- Invite codes ----------
// Whoever creates a code becomes an accepted contact automatically of
// whoever redeems it. Account creation itself now happens through Supabase
// Auth signup (see the frontend login/signup screen), so redeeming a code is
// always just "link me up with the person who shared this code."

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous characters
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

app.post('/api/invites', async (req, res) => {
  let code;
  do { code = generateInviteCode(); } while (await db.get('SELECT 1 FROM invites WHERE code = ?', [code]));
  await db.run('INSERT INTO invites (code, created_by) VALUES (?, ?)', [code, req.userId]);
  res.json({ code });
});

app.post('/api/invites/redeem', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  const invite = await db.get('SELECT * FROM invites WHERE code = ?', [code.toUpperCase()]);
  if (!invite) return res.status(404).json({ error: 'Invalid invite code' });
  if (invite.used_by) return res.status(409).json({ error: 'This invite code was already used' });
  if (invite.created_by === req.userId) return res.status(400).json({ error: "You can't redeem your own code" });

  await db.run('UPDATE invites SET used_by = ?, used_at = now() WHERE id = ?', [req.userId, invite.id]);
  await db.run(`INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'aceptado') ON CONFLICT (user_id, contact_user_id) DO UPDATE SET status = 'aceptado'`, [invite.created_by, req.userId]);
  await db.run(`INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'aceptado') ON CONFLICT (user_id, contact_user_id) DO UPDATE SET status = 'aceptado'`, [req.userId, invite.created_by]);

  const creator = await db.get('SELECT name FROM profiles WHERE id = ?', [invite.created_by]);
  res.json({ ok: true, contactName: creator?.name || null });
});

// ---------- Dashboard / stats ----------

async function computeStats(user_id) {
  const books = await db.all(`
    SELECT ub.*, b.pages, b.authors, b.categories, b.language
    FROM user_books ub JOIN books b ON b.id = ub.book_id
    WHERE ub.user_id = ?
  `, [user_id]);

  const leidos = books.filter(b => b.status === 'leido');

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

  const anioActual = new Date().getFullYear();
  const mesActual = String(new Date().getMonth() + 1).padStart(2, '0');
  const claveMesActual = `${anioActual}-${mesActual}`;
  const meta = await db.get('SELECT target_books, monthly_target FROM goals WHERE user_id = ? AND year = ?', [user_id, anioActual]);
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

app.get('/api/stats', async (req, res) => {
  res.json(await computeStats(req.userId));
});

app.get('/api/reading-now', async (req, res) => {
  const rows = await db.all(`
    SELECT ub.id, ub.start_date, ub.progress_percent, b.id as book_id, b.title, b.authors, b.cover_url, b.pages,
           b.published_year, b.categories, b.description, ub.rating
    FROM user_books ub JOIN books b ON b.id = ub.book_id
    WHERE ub.user_id = ? AND ub.status = 'leyendo'
    ORDER BY ub.start_date DESC
  `, [req.userId]);

  const withClub = [];
  for (const r of rows) {
    const club = await db.get(`
      SELECT bc.name FROM club_books cb
      JOIN book_clubs bc ON bc.id = cb.club_id
      JOIN club_members cm ON cm.club_id = cb.club_id
      WHERE cb.book_id = ? AND cm.user_id = ?
      LIMIT 1
    `, [r.book_id, req.userId]);
    withClub.push({ ...r, club_name: club ? club.name : null });
  }

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

// Used to bias the OpenLibrary "close to average year" sort AND now also as
// a fallback signal for recommendations. Kept limited to finished books —
// this is specifically "what pace/era did they actually finish reading",
// which stays meaningful even once libraryTaste() below (all owned books)
// takes over as the main driver of recommendations.
async function averageReadYear(user_id) {
  const rows = await db.all(`
    SELECT b.published_year FROM user_books ub JOIN books b ON b.id = ub.book_id
    WHERE ub.user_id = ? AND ub.status = 'leido' AND b.published_year IS NOT NULL
  `, [user_id]);
  if (!rows.length) return null;
  return Math.round(rows.reduce((sum, r) => sum + r.published_year, 0) / rows.length);
}

// Recommendations used to be driven by computeStats().top_generos, which
// only counts books with status='leido' — for a newer user (or one who adds
// books they're currently reading/plan to read without marking many as
// finished yet), that's a tiny, unrepresentative sample. Explicitly
// requested to be based on finished (status='leido') books only, once the
// user had enough of those logged — genre detection was already working
// well from this same set; the year signal specifically was the one still
// getting pulled off track without this restriction.
async function libraryTaste(user_id) {
  const rows = await db.all(`
    SELECT b.categories, b.published_year FROM user_books ub JOIN books b ON b.id = ub.book_id
    WHERE ub.user_id = ? AND ub.status = 'leido'
  `, [user_id]);

  const genreCounts = {};
  for (const r of rows) {
    if (!r.categories) continue;
    for (const g of r.categories.split(',').map(s => s.trim()).filter(Boolean)) {
      genreCounts[g] = (genreCounts[g] || 0) + 1;
    }
  }
  const topGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).map(([g]) => g);

  const years = rows.map(r => r.published_year).filter(Boolean);
  const avgYear = years.length ? Math.round(years.reduce((a, b) => a + b, 0) / years.length) : null;

  return { topGenres, avgYear, hasReadBooks: rows.length > 0 };
}

// OpenLibrary's /subjects/{x}.json?published_in=Y-Z looked like the right
// tool for year filtering, but it turned out to filter by EDITION publish
// date, not the work's original one — a reissue/reprint of a centuries-old
// classic can easily have a 2020s edition, so "published_in=2020-2029" was
// happily returning things like Don Quixote. The real fix is search.json's
// `first_publish_year:[X TO Y]` Solr range query, which reflects the WORK's
// actual original year and searches OpenLibrary's whole corpus.
//
// A later attempt switched year-scoped requests over to the curated
// /subjects/ index instead (trying to fix recommendations collapsing to one
// book), but that broke explicit year-filter browsing that had been working
// well: /subjects/ only returns its top-N works ranked by popularity/edition
// count, and for most genres essentially none of the truly recent (e.g.
// "2020s") releases are popular/established enough yet to show up in that
// top-N at all — "Fantasy" + "2020s" came back with zero results because of
// this, not a bug in the filtering logic. search.json's range query has no
// such recency bias, so it's back to being the source whenever a year
// constraint (explicit or implicit) is in play; /subjects/ is only used for
// the no-year-filter case, where "which are the most established/popular
// works in this subject" is exactly the right question to ask.
async function fetchSubjectBooks(subjectName, excludeTitles, limit, preferredYear, yearFrom, yearTo) {
  const targetLimit = limit || 8;

  let from = yearFrom;
  let to = yearTo;
  if (!from && !to && preferredYear) {
    from = preferredYear - 20;
    to = Math.max(preferredYear + 20, new Date().getFullYear());
  }

  // A network hiccup or timeout hitting OpenLibrary here used to bubble up
  // and blow up the whole request (browse showing "Could not reach Open
  // Library" instead of just a thin/empty result) — caught locally now so a
  // single slow/failed OL call degrades to "no candidates from this source"
  // rather than failing the entire browse/recommendation request.
  let works = [];
  try {
    if (from || to) {
      // Fetch a much bigger pool than what's actually returned — refreshing
      // Recommended only shuffled within a top slice barely bigger than what
      // it displayed, so hitting refresh kept surfacing near-identical sets.
      const q = `subject:"${subjectName}" AND first_publish_year:[${from || 1000} TO ${to || new Date().getFullYear()}]`;
      const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${targetLimit * 12}&fields=key,title,author_name,cover_i,first_publish_year`;
      const r = await fetchWithTimeout(url, OL_TIMEOUT);
      if (r.ok) {
        const data = await r.json();
        works = (data.docs || []).map(d => ({
          key: d.key,
          title: d.title,
          authors: (d.author_name || []).map(name => ({ name })),
          cover_id: d.cover_i,
          first_publish_year: d.first_publish_year
        }));
      }

      // search.json's `subject:"X"` field match has patchy recall for some
      // genres/phrasings (part of why recommendations occasionally came back
      // thin) — if it didn't find much, also pull from the curated /subjects/
      // index as a supplementary source and merge it in. This only ADDS
      // candidates; the exact year-range filter below still applies to
      // everything the same way regardless of where it came from, so this
      // can't reintroduce out-of-range results the way relying on /subjects/
      // as the PRIMARY source did (its top-N-by-popularity ordering is what
      // caused the "Fantasy + 2020s" zero-results bug).
      if (works.length < targetLimit * 3) {
        try {
          const slug = subjectName.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '_');
          const r2 = await fetchWithTimeout(`https://openlibrary.org/subjects/${encodeURIComponent(slug)}.json?limit=${targetLimit * 15}`, OL_TIMEOUT);
          if (r2.ok) {
            const extra = (await r2.json()).works || [];
            const seen = new Set(works.map(w => w.key));
            for (const w of extra) {
              if (!seen.has(w.key)) { works.push(w); seen.add(w.key); }
            }
          }
        } catch (err) {
          console.error('OpenLibrary /subjects/ widen failed:', err.message);
        }
      }
    } else {
      const slug = subjectName.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '_');
      const r = await fetchWithTimeout(`https://openlibrary.org/subjects/${encodeURIComponent(slug)}.json?limit=${targetLimit * 5}`, OL_TIMEOUT);
      if (r.ok) works = (await r.json()).works || [];
    }
  } catch (err) {
    console.error('OpenLibrary lookup failed:', err.message);
  }

  // A hard year filter, requested either explicitly (yearFrom/yearTo, from
  // the browse filters) or implicitly (preferredYear, from the user's actual
  // reading history for recommendations). No fallback to "just use
  // everything" when too few close matches exist — that's exactly how 1800s
  // books kept slipping into recommendations for a user who reads nothing
  // older than 2006. A smaller, correctly-scoped result beats a wrong one.
  let candidates = works.filter(w => !excludeTitles || !excludeTitles.has((w.title || '').toLowerCase()));

  let selected;
  if (preferredYear) {
    // Widened from *2 to *5 — with a small slice, shuffling barely changed
    // anything since almost the whole candidate set was already being shown,
    // which is why hitting refresh kept returning near-identical results.
    candidates.sort((a, b) => Math.abs((a.first_publish_year || 0) - preferredYear) - Math.abs((b.first_publish_year || 0) - preferredYear));
    selected = shuffleArray(candidates.slice(0, targetLimit * 5));
  } else if (!yearFrom && !yearTo) {
    // No signal about the user's era preference at all, and no explicit year
    // filter requested — default to the most recently published books
    // instead of OpenLibrary's raw subject order, which otherwise tends to
    // surface old public-domain classics first. Shuffled within that recent
    // pool (rather than a fixed sort) so hitting "refresh" on this same
    // category actually surfaces a different set instead of the identical
    // list every time.
    const withYear = candidates.filter(w => w.first_publish_year).sort((a, b) => b.first_publish_year - a.first_publish_year);
    const withoutYear = candidates.filter(w => !w.first_publish_year);
    selected = [...shuffleArray(withYear.slice(0, targetLimit * 2)), ...shuffleArray(withoutYear)];
  } else {
    selected = shuffleArray(candidates);
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

app.get('/api/recommendations', async (req, res) => {
  // Driven by libraryTaste() — status='leido' books only, per explicit
  // request — for genre AND year.
  const { topGenres, avgYear, hasReadBooks } = await libraryTaste(req.userId);
  let topGenre = topGenres[0];

  // A user can have finished books logged with no genre to show for it —
  // if `categories` was never filled in for those books (e.g. added before
  // enrichment worked, or added manually without it), topGenres comes back
  // empty even though there's perfectly good year data to work with. That's
  // a different situation from "no reading history at all" and shouldn't
  // produce the same "go mark some books as read" dead end.
  if (!topGenre && hasReadBooks) topGenre = 'fiction';
  if (!topGenre) return res.json({ subject: null, books: [], hasReadBooks });

  const ownedRows = await db.all(`
    SELECT LOWER(b.title) as t FROM user_books ub JOIN books b ON b.id = ub.book_id WHERE ub.user_id = ?
  `, [req.userId]);
  const alreadyOwned = new Set(ownedRows.map(r => r.t));

  try {
    const books = await fetchSubjectBooks(topGenre, alreadyOwned, 8, avgYear);
    res.json({ subject: topGenre, books, hasReadBooks });
  } catch (err) {
    console.error('Recommendations lookup failed:', err.message);
    // hasReadBooks must still be included here — omitting it made the
    // frontend show "mark some books as read" even when the user has
    // plenty of finished books and this was just an upstream fetch hiccup.
    res.json({ subject: topGenre, books: [], hasReadBooks });
  }
});

app.get('/api/browse', async (req, res) => {
  // category and year range are independent and combinable — either one can
  // be used alone, or both together. If no category was picked but a year
  // range was, we still need *some* OpenLibrary subject to query against,
  // so fall back to a broad "fiction" subject in that case.
  const { category, yearFrom, yearTo } = req.query;
  if (!category && !yearFrom && !yearTo) return res.status(400).json({ error: 'category or a year range is required' });
  const subject = category || 'fiction';
  try {
    // Picking just a category with no year chip used to silently pull in
    // the user's average-reading-year as an implicit filter, routing the
    // request through search.json's subject-field query (worse recall than
    // /subjects/, especially for a broad term like "Fiction") — that's why
    // plain category browsing sometimes failed with "no results" even
    // though nothing about the request looked year-scoped. No implicit year
    // filter is applied here anymore: no year chip picked means no year
    // constraint, full stop, using the more reliable /subjects/ index.
    const books = await fetchSubjectBooks(
      subject, null, 20, null,
      yearFrom ? parseInt(yearFrom) : null,
      yearTo ? parseInt(yearTo) : null
    );
    res.json(books);
  } catch (err) {
    console.error('Browse by category failed:', err.message);
    res.status(502).json({ error: 'Could not reach Open Library. Check the server logs for details.' });
  }
});

// "Popular now" — OpenLibrary has no real popularity/ratings signal, so this
// uses Google Books instead: pull a batch for the (optional) category,
// restrict to books published in roughly the last 6 years, and rank by
// ratingsCount (falling back to averageRating when tied/missing) so what
// surfaces is actually popular *recent* books, not just whatever Google's
// default relevance ranking returns.
// A classic's public-domain reissue can still slip past every check below
// (a fresh 2024 edition, real cover, and yes — sometimes even a handful of
// ratings on that specific listing from people rating the *work*, not the
// edition). This list of Google Books category tags is the most reliable
// remaining signal: legitimately new popular fiction is essentially never
// tagged this way, while classic reissues almost always are.
const CLASSIC_CATEGORY_HINTS = ['classic', 'literary criticism', 'literary collections'];

// Google Books' listing title for a reissue is often decorated with
// subtitle/edition noise ("Don Quixote (Barnes & Noble Classics Series)",
// "Pride and Prejudice: The Annotated Edition") that doesn't literally match
// OpenLibrary's plain title ("Don Quixote"). An exact-phrase title search
// was silently failing to match on exactly the reissues this needs to
// catch, leaving their wrong (edition) year in place. Stripping everything
// from the first ":" or "(" onward gets back to the plain, matchable title.
function normalizeTitle(title) {
  return (title || '').split(/[:(]/)[0].trim().toLowerCase();
}

// Cross-checks a batch of titles against OpenLibrary's search index to get
// each book's real, WORK-level first_publish_year — this is the only
// reliable fix for the "Don Quixote shows up as a 2021 release" problem.
// Google Books' own published_year is per-EDITION (a reissue's cover date),
// and neither category tags nor ratings data reliably distinguish a classic
// reissue from an actual new release, so this is worth the extra request.
// Matching by ISBN was tried first, but OpenLibrary's ISBN coverage for
// random modern paperback printings is spotty. A single combined OR query
// was tried next, but mapping each returned doc back to the title that
// matched it is unreliable (OL doesn't echo back which query term hit) —
// so this does one search per unique normalized title instead, in parallel,
// trusting OpenLibrary's own relevance ranking to surface the right work
// for what's usually a well-known, unambiguous title.
async function lookupOriginalYears(titles) {
  const normalized = [...new Set(titles.map(normalizeTitle).filter(Boolean))];
  const results = await Promise.all(normalized.map(async (title) => {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(title)}&fields=title,first_publish_year&limit=1`;
    try {
      const r = await fetchWithTimeout(url, OL_TIMEOUT);
      if (!r.ok) return [title, null];
      const data = await r.json();
      return [title, data.docs?.[0]?.first_publish_year || null];
    } catch {
      return [title, null];
    }
  }));
  return Object.fromEntries(results.filter(([, year]) => year !== null));
}

app.get('/api/popular', async (req, res) => {
  const { category, yearFrom, yearTo } = req.query;
  const q = category ? `subject:${category}` : 'subject:fiction';
  // Random startIndex each call (instead of always 0) so hitting "refresh"
  // actually pulls a different slice of Google's results, not just the same
  // ~40 candidates reshuffled into a different order every time.
  const startIndex = Math.floor(Math.random() * 3) * 20;
  const url = withGoogleKey(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&orderBy=relevance&maxResults=40&startIndex=${startIndex}`);
  try {
    const r = await fetchWithTimeout(url, 6000);
    const data = await r.json();
    if (!r.ok || data.error) {
      console.error('Google Books (popular) returned an error:', r.status, JSON.stringify(data.error || data));
      return res.json({ books: [] });
    }
    let items = (data.items || [])
      .map(item => {
        const info = item.volumeInfo || {};
        const year = info.publishedDate ? parseInt(info.publishedDate.slice(0, 4)) : null;
        const isbn = (info.industryIdentifiers || []).find(i => i.type === 'ISBN_13')?.identifier
          || (info.industryIdentifiers || [])[0]?.identifier || null;
        const categories = (info.categories || []).join(', ');
        return {
          api_id: item.id,
          isbn,
          title: info.title || 'Untitled',
          authors: (info.authors || []).join(', '),
          cover_url: info.imageLinks?.thumbnail || (isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg` : null),
          pages: info.pageCount || null,
          published_year: year,
          categories: categories || category || null,
          language: info.language || null,
          ratingsCount: info.ratingsCount || 0,
          averageRating: info.averageRating || 0
        };
      })
      // Never relaxed: a classic/literary-criticism tag rules a book out
      // regardless of anything else.
      .filter(b => !CLASSIC_CATEGORY_HINTS.some(hint => (b.categories || '').toLowerCase().includes(hint)));

    // Cross-check against OpenLibrary for the real original-publication
    // year — only for books that at least LOOK recent by Google's (edition)
    // date, to keep this to a reasonable number of lookups.
    const currentYear = new Date().getFullYear();
    const titlesToCheck = items.filter(b => b.title && (!b.published_year || b.published_year >= currentYear - 15)).map(b => b.title);
    const originalYears = await lookupOriginalYears(titlesToCheck);
    items = items.map(b => {
      const found = originalYears[normalizeTitle(b.title)];
      return found ? { ...b, published_year: found } : b;
    });

    const hasRatingSignal = b => b.ratingsCount >= 1 || b.averageRating > 0;

    let filtered;
    if (yearFrom || yearTo) {
      // An explicit year filter is a hard requirement from the user, not a
      // soft "prefer recent" default — it never gets widened beyond what
      // was actually asked for, only the rating requirement gets relaxed
      // if too few books in that exact range have rating data.
      const from = parseInt(yearFrom) || 0;
      const to = parseInt(yearTo) || currentYear;
      const inRange = b => !!b.published_year && b.published_year >= from && b.published_year <= to;
      filtered = items.filter(b => inRange(b) && hasRatingSignal(b));
      if (filtered.length < 6) filtered = items.filter(inRange);
    } else {
      // No explicit year filter — default to "recent", widening the window
      // in steps if that leaves too few, but NEVER dropping the year
      // restriction altogether (that's exactly how corrected-to-ancient
      // classics kept slipping back in via the last-resort fallback this
      // replaces — always excluding classics isn't enough on its own if
      // there's no floor on how old "popular now" is allowed to mean).
      filtered = items.filter(b => (!b.published_year || b.published_year >= currentYear - 6) && hasRatingSignal(b));
      if (filtered.length < 6) filtered = items.filter(b => (!b.published_year || b.published_year >= currentYear - 10) && hasRatingSignal(b));
      if (filtered.length < 6) filtered = items.filter(b => !b.published_year || b.published_year >= currentYear - 15);
    }

    filtered.sort((a, b) => (b.ratingsCount - a.ratingsCount) || (b.averageRating - a.averageRating) || (b.published_year || 0) - (a.published_year || 0));

    // Google's own ranking is deterministic, so without this, hitting
    // "refresh" would show the exact same books just reordered — shuffling
    // within the top slice of the (already quality-filtered, ranked) pool
    // means refreshing surfaces a genuinely different set.
    const popular = shuffleArray(filtered.slice(0, 24));

    res.json({ books: popular.slice(0, 12).map(({ ratingsCount, averageRating, ...b }) => b) });
  } catch (err) {
    console.error('Popular lookup failed:', err.message);
    res.json({ books: [] });
  }
});

app.get('/api/compare', async (req, res) => {
  const { contact_user_id } = req.query;
  if (!contact_user_id) return res.status(400).json({ error: 'contact_user_id is required' });

  const isContact = await db.get(`
    SELECT 1 FROM contacts WHERE user_id = ? AND contact_user_id = ? AND status = 'aceptado'
  `, [req.userId, contact_user_id]);
  if (!isContact) return res.status(403).json({ error: 'You can only compare with accepted contacts' });

  const meLibros = (await db.all(`SELECT book_id FROM user_books WHERE user_id = ? AND status = 'leido'`, [req.userId])).map(r => r.book_id);
  const contactoLibros = (await db.all(`SELECT book_id FROM user_books WHERE user_id = ? AND status = 'leido'`, [contact_user_id])).map(r => r.book_id);
  const enComun = meLibros.filter(id => contactoLibros.includes(id));
  const comunInfo = enComun.length
    ? await db.all(`SELECT id, title FROM books WHERE id IN (${enComun.map(() => '?').join(',')})`, enComun)
    : [];

  res.json({
    yo: await computeStats(req.userId),
    contacto: await computeStats(contact_user_id),
    libros_en_comun: comunInfo
  });
});

app.get('/api/feed', async (req, res) => {
  const contactRows = await db.all(`SELECT contact_user_id FROM contacts WHERE user_id = ? AND status = 'aceptado'`, [req.userId]);
  const contactIds = contactRows.map(r => r.contact_user_id);
  if (!contactIds.length) return res.json([]);

  const placeholders = contactIds.map(() => '?').join(',');
  const rows = await db.all(`
    SELECT ub.id, ub.status, ub.rating, ub.updated_at, ub.end_date, ub.start_date,
           u.id as user_id, u.name as user_name, u.username, u.avatar_seed,
           b.title, b.authors, b.cover_url, b.pages, b.categories
    FROM user_books ub
    JOIN profiles u ON u.id = ub.user_id
    JOIN books b ON b.id = ub.book_id
    WHERE ub.user_id IN (${placeholders}) AND ub.status IN ('leido', 'leyendo')
    ORDER BY ub.updated_at DESC
    LIMIT 30
  `, contactIds);

  res.json(rows);
});

// ---------- Book Clubs ----------
// Anyone can create a club and be found by name so contacts can join
// directly (no approval step). Only the owner can rename/describe the club,
// add/remove members, manage the reading list, and set/remove weekly goals.
// Every member tracks their own completion of each weekly goal.

async function isClubMember(clubId, userId) {
  return !!(await db.get('SELECT 1 FROM club_members WHERE club_id = ? AND user_id = ?', [clubId, userId]));
}
async function isClubOwner(clubId, userId) {
  const club = await db.get('SELECT owner_user_id FROM book_clubs WHERE id = ?', [clubId]);
  return !!club && club.owner_user_id === userId;
}

async function syncClubBookToMemberLibraries(clubId, bookId, targetStatus, memberIds) {
  const today = new Date().toISOString().slice(0, 10);
  const members = memberIds || (await db.all('SELECT user_id FROM club_members WHERE club_id = ?', [clubId])).map(r => r.user_id);

  for (const userId of members) {
    const existing = await db.get('SELECT * FROM user_books WHERE user_id = ? AND book_id = ?', [userId, bookId]);

    if (targetStatus === 'leyendo') {
      if (!existing) {
        await db.run(`INSERT INTO user_books (user_id, book_id, status, start_date) VALUES (?, ?, 'leyendo', ?)`, [userId, bookId, today]);
      } else if (existing.status === 'por_leer') {
        await db.run(`UPDATE user_books SET status = 'leyendo', start_date = COALESCE(start_date, ?) WHERE id = ?`, [today, existing.id]);
      }
    } else if (targetStatus === 'leido') {
      if (!existing) {
        await db.run(`INSERT INTO user_books (user_id, book_id, status, start_date, end_date) VALUES (?, ?, 'leido', ?, ?)`, [userId, bookId, today, today]);
      } else if (existing.status !== 'leido') {
        await db.run(`UPDATE user_books SET status = 'leido', start_date = COALESCE(start_date, ?), end_date = ? WHERE id = ?`, [today, today, existing.id]);
      }
    }
  }
}

app.post('/api/clubs', async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const existing = await db.get('SELECT id FROM book_clubs WHERE LOWER(name) = LOWER(?)', [name.trim()]);
  if (existing) return res.status(409).json({ error: 'A club with that name already exists' });

  try {
    const club = await db.withTransaction(async (tx) => {
      const info = await tx.run('INSERT INTO book_clubs (name, description, owner_user_id) VALUES (?, ?, ?)', [name.trim(), description || null, req.userId]);
      await tx.run(`INSERT INTO club_members (club_id, user_id, role) VALUES (?, ?, 'owner')`, [info.lastInsertRowid, req.userId]);
      return tx.get('SELECT * FROM book_clubs WHERE id = ?', [info.lastInsertRowid]);
    });
    res.json(club);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clubs/search', async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.json([]);
  const rows = await db.all(`
    SELECT bc.*, (SELECT COUNT(*) FROM club_members cm WHERE cm.club_id = bc.id) as member_count
    FROM book_clubs bc
    WHERE bc.name ILIKE ?
    LIMIT 20
  `, [`%${q.trim()}%`]);
  const withMembership = [];
  for (const c of rows) withMembership.push({ ...c, is_member: await isClubMember(c.id, req.userId) });
  res.json(withMembership);
});

app.get('/api/clubs', async (req, res) => {
  const rows = await db.all(`
    SELECT bc.*, cm.role,
           (SELECT COUNT(*) FROM club_members cm2 WHERE cm2.club_id = bc.id) as member_count
    FROM club_members cm
    JOIN book_clubs bc ON bc.id = cm.club_id
    WHERE cm.user_id = ?
    ORDER BY bc.created_at DESC
  `, [req.userId]);
  res.json(rows);
});

app.post('/api/clubs/:id/join', async (req, res) => {
  const club = await db.get('SELECT id FROM book_clubs WHERE id = ?', [req.params.id]);
  if (!club) return res.status(404).json({ error: 'Club not found' });
  if (await isClubMember(club.id, req.userId)) return res.status(409).json({ error: 'You are already a member of this club' });
  await db.run(`INSERT INTO club_members (club_id, user_id, role) VALUES (?, ?, 'member')`, [club.id, req.userId]);

  const currentBook = await db.get(`SELECT book_id FROM club_books WHERE club_id = ? AND status = 'current'`, [club.id]);
  if (currentBook) await syncClubBookToMemberLibraries(club.id, currentBook.book_id, 'leyendo', [req.userId]);

  res.json({ ok: true });
});

app.post('/api/clubs/:id/leave', async (req, res) => {
  if (await isClubOwner(req.params.id, req.userId)) {
    return res.status(400).json({ error: 'The owner cannot leave — delete the club instead' });
  }
  await db.run('DELETE FROM club_members WHERE club_id = ? AND user_id = ?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

app.patch('/api/clubs/:id', async (req, res) => {
  const { name, description } = req.body;
  if (!(await isClubOwner(req.params.id, req.userId))) return res.status(403).json({ error: 'Only the club owner can edit it' });
  if (name && name.trim()) {
    const clash = await db.get('SELECT id FROM book_clubs WHERE LOWER(name) = LOWER(?) AND id != ?', [name.trim(), req.params.id]);
    if (clash) return res.status(409).json({ error: 'A club with that name already exists' });
  }
  await db.run(`
    UPDATE book_clubs SET name = COALESCE(?, name), description = ? WHERE id = ?
  `, [name && name.trim() ? name.trim() : null, description ?? null, req.params.id]);
  res.json(await db.get('SELECT * FROM book_clubs WHERE id = ?', [req.params.id]));
});

app.delete('/api/clubs/:id', async (req, res) => {
  if (!(await isClubOwner(req.params.id, req.userId))) return res.status(403).json({ error: 'Only the club owner can delete it' });
  await db.run('DELETE FROM book_clubs WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/clubs/:id/members/:memberId', async (req, res) => {
  if (!(await isClubOwner(req.params.id, req.userId))) return res.status(403).json({ error: 'Only the club owner can remove members' });
  if (req.params.memberId === req.userId) return res.status(400).json({ error: 'The owner cannot remove themself — delete the club instead' });
  await db.run('DELETE FROM club_members WHERE club_id = ? AND user_id = ?', [req.params.id, req.params.memberId]);
  res.json({ ok: true });
});

app.get('/api/clubs/:id', async (req, res) => {
  const club = await db.get('SELECT * FROM book_clubs WHERE id = ?', [req.params.id]);
  if (!club) return res.status(404).json({ error: 'Club not found' });
  if (!(await isClubMember(club.id, req.userId))) return res.status(403).json({ error: 'You are not a member of this club' });

  const members = await db.all(`
    SELECT u.id, u.name, u.username, u.avatar_seed, cm.role, cm.joined_at
    FROM club_members cm JOIN profiles u ON u.id = cm.user_id
    WHERE cm.club_id = ?
    ORDER BY cm.role DESC, cm.joined_at ASC
  `, [club.id]);

  const books = await db.all(`
    SELECT cb.id as club_book_id, cb.status, cb.created_at, b.*
    FROM club_books cb JOIN books b ON b.id = cb.book_id
    WHERE cb.club_id = ?
    ORDER BY (cb.status = 'current') DESC, cb.created_at DESC
  `, [club.id]);

  const goalRows = await db.all(`
    SELECT cg.*, cb.book_id
    FROM club_goals cg LEFT JOIN club_books cb ON cb.id = cg.club_book_id
    WHERE cg.club_id = ?
    ORDER BY cg.week_start DESC, cg.created_at DESC
  `, [club.id]);

  const goals = [];
  for (const g of goalRows) {
    const bookTitle = g.book_id ? (await db.get('SELECT title FROM books WHERE id = ?', [g.book_id]))?.title : null;
    const progressRows = await db.all('SELECT user_id, completed_at FROM club_goal_progress WHERE goal_id = ?', [g.id]);
    const completedIds = new Set(progressRows.map(p => p.user_id));
    const memberStatus = members.map(m => ({
      user_id: m.id,
      name: m.name,
      avatar_seed: m.avatar_seed,
      completed: completedIds.has(m.id)
    }));
    goals.push({
      id: g.id,
      club_book_id: g.club_book_id,
      book_title: bookTitle,
      description: g.description,
      week_start: g.week_start,
      members: memberStatus,
      completed_count: memberStatus.filter(m => m.completed).length,
      total_members: memberStatus.length
    });
  }

  res.json({ ...club, my_role: members.find(m => m.id === req.userId)?.role || null, members, books, goals });
});

app.post('/api/clubs/:id/books', async (req, res) => {
  const { book, status } = req.body;
  if (!(await isClubOwner(req.params.id, req.userId))) return res.status(403).json({ error: 'Only the club owner can add books' });
  if (!book) return res.status(400).json({ error: 'book is required' });
  book.api_id = book.api_id || `manual-${book.isbn || book.title}`;
  await enrichBook(book);
  const bookRow = await findOrCreateBook(book);

  const desiredStatus = status === 'current' ? 'current' : 'upcoming';
  if (desiredStatus === 'current') {
    await db.run(`UPDATE club_books SET status = 'upcoming' WHERE club_id = ? AND status = 'current'`, [req.params.id]);
  }
  await db.run(`
    INSERT INTO club_books (club_id, book_id, status, added_by) VALUES (?, ?, ?, ?)
  `, [req.params.id, bookRow.id, desiredStatus, req.userId]);

  if (desiredStatus === 'current') await syncClubBookToMemberLibraries(req.params.id, bookRow.id, 'leyendo');

  res.json({ ok: true });
});

app.patch('/api/clubs/:id/books/:clubBookId', async (req, res) => {
  const { status } = req.body;
  if (!(await isClubOwner(req.params.id, req.userId))) return res.status(403).json({ error: 'Only the club owner can update the reading list' });
  if (!['current', 'upcoming', 'done'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const clubBook = await db.get('SELECT * FROM club_books WHERE id = ? AND club_id = ?', [req.params.clubBookId, req.params.id]);
  if (!clubBook) return res.status(404).json({ error: 'Book not found in this club' });

  if (status === 'current') {
    await db.run(`UPDATE club_books SET status = 'upcoming' WHERE club_id = ? AND status = 'current'`, [req.params.id]);
  }
  await db.run('UPDATE club_books SET status = ? WHERE id = ? AND club_id = ?', [status, req.params.clubBookId, req.params.id]);

  if (status === 'current') await syncClubBookToMemberLibraries(req.params.id, clubBook.book_id, 'leyendo');
  if (status === 'done') await syncClubBookToMemberLibraries(req.params.id, clubBook.book_id, 'leido');

  res.json({ ok: true });
});

app.delete('/api/clubs/:id/books/:clubBookId', async (req, res) => {
  if (!(await isClubOwner(req.params.id, req.userId))) return res.status(403).json({ error: 'Only the club owner can update the reading list' });
  const clubBook = await db.get('SELECT * FROM club_books WHERE id = ? AND club_id = ?', [req.params.clubBookId, req.params.id]);
  if (!clubBook) return res.status(404).json({ error: 'Book not found in this club' });

  await db.run('DELETE FROM club_goals WHERE club_book_id = ?', [req.params.clubBookId]);

  const memberIds = (await db.all('SELECT user_id FROM club_members WHERE club_id = ?', [req.params.id])).map(r => r.user_id);
  if (memberIds.length) {
    const placeholders = memberIds.map(() => '?').join(',');
    await db.run(`DELETE FROM user_books WHERE book_id = ? AND user_id IN (${placeholders})`, [clubBook.book_id, ...memberIds]);
  }

  await db.run('DELETE FROM club_books WHERE id = ? AND club_id = ?', [req.params.clubBookId, req.params.id]);
  res.json({ ok: true });
});

app.post('/api/clubs/:id/goals', async (req, res) => {
  const { club_book_id, description, week_start } = req.body;
  if (!(await isClubOwner(req.params.id, req.userId))) return res.status(403).json({ error: 'Only the club owner can set weekly goals' });
  if (!description || !description.trim() || !week_start) return res.status(400).json({ error: 'description and week_start are required' });

  const info = await db.run(`
    INSERT INTO club_goals (club_id, club_book_id, description, week_start, created_by)
    VALUES (?, ?, ?, ?, ?)
  `, [req.params.id, club_book_id || null, description.trim(), week_start, req.userId]);
  res.json({ id: info.lastInsertRowid, ok: true });
});

app.delete('/api/clubs/:id/goals/:goalId', async (req, res) => {
  if (!(await isClubOwner(req.params.id, req.userId))) return res.status(403).json({ error: 'Only the club owner can remove weekly goals' });
  await db.run('DELETE FROM club_goals WHERE id = ? AND club_id = ?', [req.params.goalId, req.params.id]);
  res.json({ ok: true });
});

app.post('/api/clubs/:id/goals/:goalId/complete', async (req, res) => {
  if (!(await isClubMember(req.params.id, req.userId))) return res.status(403).json({ error: 'You are not a member of this club' });
  await db.run(`
    INSERT INTO club_goal_progress (goal_id, user_id) VALUES (?, ?) ON CONFLICT (goal_id, user_id) DO NOTHING
  `, [req.params.goalId, req.userId]);
  res.json({ ok: true });
});

app.delete('/api/clubs/:id/goals/:goalId/complete', async (req, res) => {
  await db.run('DELETE FROM club_goal_progress WHERE goal_id = ? AND user_id = ?', [req.params.goalId, req.userId]);
  res.json({ ok: true });
});

// ---------- Achievements ----------

app.get('/api/achievements', async (req, res) => {
  const stats = await computeStats(req.userId);
  const contactCount = (await db.get(`SELECT COUNT(*) as c FROM contacts WHERE user_id = ? AND status = 'aceptado'`, [req.userId])).c;
  const genreCount = stats.top_generos.length;
  const yearGoalMet = stats.meta_anual && stats.leidos_este_anio >= stats.meta_anual;
  const overachiever = stats.meta_anual && stats.leidos_este_anio >= stats.meta_anual * 1.5;

  const recruitedCount = (await db.get(`
    SELECT COUNT(*) as c FROM invites WHERE created_by = ? AND used_by IS NOT NULL
  `, [req.userId])).c;

  const ratedCount = (await db.get(`
    SELECT COUNT(*) as c FROM user_books WHERE user_id = ? AND status = 'leido' AND rating IS NOT NULL
  `, [req.userId])).c;

  const profile = await db.get('SELECT created_at FROM profiles WHERE id = ?', [req.userId]);
  const accountDays = profile ? Math.floor((Date.now() - new Date(profile.created_at).getTime()) / (1000 * 60 * 60 * 24)) : 0;

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

// Errors thrown inside async route handlers above reject their promise;
// Express 4 doesn't catch those automatically, so a small wrapper-free
// safety net logs them instead of the process crashing silently.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3300;
app.listen(PORT, () => console.log(`ReadTrack running on port ${PORT}`));
