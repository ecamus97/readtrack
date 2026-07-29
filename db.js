// Production DB layer: Postgres via Supabase, using the `pg` driver directly
// (not the Supabase JS query builder) because a lot of our queries are
// multi-table joins and aggregations that are far more natural as raw SQL.
//
// This replaces the old node:sqlite version. Every call site in server.js
// was rewritten to be async (`await db.get(...)`, etc.) since Postgres access
// is inherently asynchronous, unlike node:sqlite's synchronous API.
//
// Query helpers accept `?` placeholders (like the old sqlite code did) and
// convert them to Postgres's `$1, $2, ...` style automatically, so the SQL in
// server.js reads the same as before wherever possible.
const { Pool, types } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill in your Supabase connection string.');
}

// By default node-postgres parses `date` columns into JS Date objects, but
// all of our date logic (computeStats month-keys, the calendar view, etc.)
// was written against plain 'YYYY-MM-DD' strings, same as node:sqlite always
// returned. Disabling that parsing keeps every existing `.slice(0,7)` /
// `.startsWith(...)` / string-comparison call working unchanged. (OID 1082 =
// date). timestamptz columns (created_at, etc.) are left as native Date
// objects — those serialize to proper ISO strings in JSON responses, which
// is what we want for anything the frontend just displays via `new Date(...)`.
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase's Postgres requires SSL; the default self-signed-looking chain
  // trips Node's strict verification in some setups, so we relax just the
  // certificate check (the connection itself is still encrypted).
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client:', err.message);
});

function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// INSERT ... (no RETURNING) needs one added so callers can read back the new
// row's id, the same way node:sqlite's `.lastInsertRowid` worked.
function withReturningId(sql) {
  if (!/^\s*insert/i.test(sql) || /returning/i.test(sql)) return sql;
  return sql.replace(/;?\s*$/, ' RETURNING id');
}

async function all(sql, params = []) {
  const { rows } = await pool.query(toPositional(sql), params);
  return rows;
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

async function run(sql, params = []) {
  const finalSql = withReturningId(sql);
  const result = await pool.query(toPositional(finalSql), params);
  return { lastInsertRowid: result.rows[0]?.id ?? null, changes: result.rowCount };
}

// For statements that touch multiple tables and must succeed or fail
// together (e.g. creating a club + its owner membership row). `fn` receives
// its own {all, get, run} bound to a single dedicated client — mixing a
// transaction with the shared pool would let unrelated queries jump in
// between BEGIN and COMMIT on a different connection.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scoped = {
      all: async (sql, params = []) => (await client.query(toPositional(sql), params)).rows,
      get: async (sql, params = []) => {
        const rows = (await client.query(toPositional(sql), params)).rows;
        return rows[0] || null;
      },
      run: async (sql, params = []) => {
        const result = await client.query(toPositional(withReturningId(sql)), params);
        return { lastInsertRowid: result.rows[0]?.id ?? null, changes: result.rowCount };
      }
    };
    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { all, get, run, withTransaction, pool };
