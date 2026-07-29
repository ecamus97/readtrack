// Usamos el módulo SQLite integrado en Node (>=22.5), evitando dependencias
// nativas que requieren compilación (better-sqlite3 no compila en este sandbox
// sin acceso a los headers de Node). API muy similar a better-sqlite3.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'readtrack.db'));
// Nota: se evita WAL porque algunos sistemas de archivos montados (ej. carpetas
// sincronizadas) no soportan bien el archivo -wal/-shm compartido.
db.exec('PRAGMA journal_mode = DELETE;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  avatar_seed TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Catalogo unico de libros, compartido entre todos los usuarios.
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_id TEXT UNIQUE,          -- id externo (Google Books volume id)
  isbn TEXT,
  title TEXT NOT NULL,
  authors TEXT,                -- csv de autores
  cover_url TEXT,
  pages INTEGER,
  published_year INTEGER,
  categories TEXT,             -- csv de generos/categorias
  language TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Relacion usuario-libro: cada usuario tiene su propio estado/rating/fechas
-- sobre un mismo registro de books.
CREATE TABLE IF NOT EXISTS user_books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'por_leer' CHECK(status IN ('por_leer','leyendo','leido')),
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  notes TEXT,
  start_date TEXT,
  end_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, book_id)
);

-- Mantiene updated_at al dia para poder armar el feed de actividad social.
CREATE TRIGGER IF NOT EXISTS trg_user_books_updated_at
AFTER UPDATE ON user_books
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE user_books SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_user_books_inserted_at
AFTER INSERT ON user_books
WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE user_books SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Contactos: solo se comparan/ven estadisticas entre contactos aceptados.
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK(status IN ('pendiente','aceptado')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, contact_user_id)
);

-- Metas de lectura por usuario y año (anual + mensual, y a futuro cualquier
-- otra preferencia de configuración que se agregue).
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  target_books INTEGER NOT NULL DEFAULT 0,
  monthly_target INTEGER,
  UNIQUE(user_id, year)
);

-- Codigos de invitacion: quien los crea queda automaticamente como contacto
-- aceptado de quien los canjea, sin pasar por la solicitud/aceptacion manual.
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  used_at TEXT
);

-- Book clubs: cualquiera puede crear uno y encontrarlo buscando su nombre
-- para unirse directamente. Solo el dueño administra miembros, libros y metas.
CREATE TABLE IF NOT EXISTS book_clubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS club_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL REFERENCES book_clubs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
  joined_at TEXT DEFAULT (datetime('now')),
  UNIQUE(club_id, user_id)
);

-- Libros que el club va a leer / esta leyendo / ya termino. Solo el dueño
-- puede agregarlos (via el buscador, en "modo club").
CREATE TABLE IF NOT EXISTS club_books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL REFERENCES book_clubs(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('current','upcoming','done')),
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Objetivos semanales (ej. "1 capitulo"), opcionalmente ligados a un libro
-- especifico del club. Solo el dueño los crea/elimina.
CREATE TABLE IF NOT EXISTS club_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL REFERENCES book_clubs(id) ON DELETE CASCADE,
  club_book_id INTEGER REFERENCES club_books(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  week_start TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Cada miembro marca su propio avance de un objetivo semanal (independiente
-- del progreso de los demas), para poder ver quien va al dia y quien no.
CREATE TABLE IF NOT EXISTS club_goal_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES club_goals(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(goal_id, user_id)
);
`);

// Migracion simple: si la base ya existia de una version anterior sin
// updated_at, se agrega la columna a mano (CREATE TABLE IF NOT EXISTS no
// modifica tablas ya creadas).
const cols = db.prepare("PRAGMA table_info(user_books)").all().map(c => c.name);
if (!cols.includes('updated_at')) {
  // SQLite no permite un DEFAULT no-constante (como datetime('now')) en
  // ALTER TABLE ADD COLUMN, así que se agrega sin default y se rellena aparte.
  // El trigger de INSERT de arriba se encarga de las filas nuevas de ahora en más.
  db.exec('ALTER TABLE user_books ADD COLUMN updated_at TEXT');
  db.exec("UPDATE user_books SET updated_at = created_at WHERE updated_at IS NULL");
}
if (!cols.includes('planned_start_date')) {
  // Fechas para la vista de calendario: cuando planeas empezar un libro "por
  // leer" y (opcional) cuando estimas terminarlo. Para libros "leyendo" se
  // usa el start_date real y solo planned_end_date es relevante.
  db.exec('ALTER TABLE user_books ADD COLUMN planned_start_date TEXT');
  db.exec('ALTER TABLE user_books ADD COLUMN planned_end_date TEXT');
}

const goalCols = db.prepare("PRAGMA table_info(goals)").all().map(c => c.name);
if (!goalCols.includes('monthly_target')) {
  db.exec('ALTER TABLE goals ADD COLUMN monthly_target INTEGER');
}

const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('username')) {
  // No se puede agregar una columna UNIQUE directamente con ALTER TABLE en
  // SQLite, así que se agrega simple y la unicidad se aplica con un índice.
  db.exec('ALTER TABLE users ADD COLUMN username TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
}
if (!userCols.includes('avatar_seed')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar_seed TEXT');
}

module.exports = db;
