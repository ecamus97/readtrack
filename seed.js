// Sample data script, so you can try the app without having to search for
// books manually first.
const db = require('./db');

const insertUser = db.prepare('INSERT OR IGNORE INTO users (name, email, username, avatar_seed) VALUES (?, ?, ?, ?)');
const getUser = db.prepare('SELECT id FROM users WHERE email = ?');

insertUser.run('Esteban', 'ecamus@apprecio.com', 'esteban', 'esteban');
insertUser.run('Demo Friend', 'amigo@demo.com', 'demo_friend', 'demo_friend');

const esteban = getUser.get('ecamus@apprecio.com').id;
const amigo = getUser.get('amigo@demo.com').id;

const insertBook = db.prepare(`
  INSERT OR IGNORE INTO books (api_id, isbn, title, authors, cover_url, pages, published_year, categories, language)
  VALUES (@api_id, @isbn, @title, @authors, @cover_url, @pages, @published_year, @categories, @language)
`);
const getBookByApiId = db.prepare('SELECT id FROM books WHERE api_id = ?');

const sampleBooks = [
  {
    api_id: 'demo-cien-anos',
    isbn: '9780307474728',
    title: 'Cien años de soledad',
    authors: 'Gabriel García Márquez',
    cover_url: 'https://covers.openlibrary.org/b/isbn/9780307474728-M.jpg',
    pages: 417,
    published_year: 1967,
    categories: 'Ficción,Realismo mágico',
    language: 'es'
  },
  {
    api_id: 'demo-sapiens',
    isbn: '9780062316097',
    title: 'Sapiens: De animales a dioses',
    authors: 'Yuval Noah Harari',
    cover_url: 'https://covers.openlibrary.org/b/isbn/9780062316097-M.jpg',
    pages: 443,
    published_year: 2011,
    categories: 'No ficción,Historia',
    language: 'es'
  },
  {
    api_id: 'demo-hobbit',
    isbn: '9780547928227',
    title: 'El Hobbit',
    authors: 'J.R.R. Tolkien',
    cover_url: 'https://covers.openlibrary.org/b/isbn/9780547928227-M.jpg',
    pages: 310,
    published_year: 1937,
    categories: 'Fantasía',
    language: 'es'
  }
];

for (const b of sampleBooks) insertBook.run(b);

const insertUserBook = db.prepare(`
  INSERT OR IGNORE INTO user_books (user_id, book_id, status, rating, start_date, end_date)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const cienAnos = getBookByApiId.get('demo-cien-anos').id;
const sapiens = getBookByApiId.get('demo-sapiens').id;
const hobbit = getBookByApiId.get('demo-hobbit').id;

insertUserBook.run(esteban, cienAnos, 'leido', 5, '2026-01-05', '2026-01-20');
insertUserBook.run(esteban, sapiens, 'leyendo', null, '2026-07-01', null);
insertUserBook.run(esteban, hobbit, 'por_leer', null, null, null);
insertUserBook.run(amigo, cienAnos, 'leido', 4, '2025-12-01', '2025-12-15');
insertUserBook.run(amigo, hobbit, 'leido', 5, '2026-02-01', '2026-02-10');

db.prepare('INSERT OR IGNORE INTO goals (user_id, year, target_books) VALUES (?, ?, ?)').run(esteban, 2026, 20);

db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, ?)').run(esteban, amigo, 'aceptado');
db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, ?)').run(amigo, esteban, 'aceptado');

console.log('Seed completado. Usuarios: Esteban (id=' + esteban + '), Amigo Demo (id=' + amigo + ')');
