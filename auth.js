// Verifies the Supabase session token the frontend sends with every request
// and attaches the authenticated user's id to req.userId. This is what
// replaces the old model where the browser just told the server which
// user_id to act as (which anyone could have spoofed) — now the server
// always figures out "who's asking" itself, from a token Supabase issued.
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — auth will reject every request.');
}

// The service role key is used server-side only (never sent to the browser)
// so we can ask Supabase "is this token valid, and whose is it" directly.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired session' });
    req.userId = data.user.id;
    req.userEmail = data.user.email;
    next();
  } catch (err) {
    console.error('Auth check failed:', err.message);
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

module.exports = { requireAuth, supabaseAdmin };
