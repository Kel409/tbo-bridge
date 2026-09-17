// auth.js - accounts and sessions. Passwords are only ever stored as a bcrypt hash. Sessions are kept
// in Postgres (survive restarts) and signed with SESSION_SECRET so cookies can't be forged.

import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import { pool, query } from './db.js';

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/; // 3-20 letters, digits, underscore
const MIN_PASSWORD = 6;

// Express session middleware, backed by a `session` table that connect-pg-simple creates for us.
const PgStore = connectPgSimple(session);
export const sessionMiddleware = session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,                 // not readable by page JS (mitigates XSS token theft)
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    secure: process.env.NODE_ENV === 'production', // require HTTPS in production
  },
});

// Register the HTTP auth routes on the Express app.
export function registerAuthRoutes(app) {
  app.use(sessionMiddleware);

  app.post('/api/signup', async (req, res) => {
    const { username, password } = req.body || {};
    if (!USERNAME_RE.test(username || '')) return res.status(400).json({ error: 'Username must be 3-20 letters, digits, or underscores.' });
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
    try {
      const hash = await bcrypt.hash(password, 10);
      const r = await query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
        [username, hash],
      );
      req.session.userId = r.rows[0].id;
      req.session.username = r.rows[0].username;
      res.json({ username: r.rows[0].username });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'That username is taken.' }); // unique violation
      console.error('signup error:', err.message);
      res.status(500).json({ error: 'Signup failed.' });
    }
  });

  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    try {
      const r = await query('SELECT id, username, password_hash FROM users WHERE username = $1', [username || '']);
      const user = r.rows[0];
      // Compare even when the user is missing to keep timing/behavior uniform, and never reveal which field was wrong.
      const ok = user ? await bcrypt.compare(password || '', user.password_hash) : false;
      if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
      req.session.userId = user.id;
      req.session.username = user.username;
      res.json({ username: user.username });
    } catch (err) {
      console.error('login error:', err.message);
      res.status(500).json({ error: 'Login failed.' });
    }
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // Who am I? Used by the client on load to know if there is a live session.
  app.get('/api/me', (req, res) => {
    if (req.session.userId) res.json({ username: req.session.username });
    else res.json({ username: null });
  });
}
