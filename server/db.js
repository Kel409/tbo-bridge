// db.js - Postgres connection (Neon) and schema setup. The connection string is a SECRET and is read
// from the DATABASE_URL environment variable; it is never hard-coded or committed.

import 'dotenv/config'; // loads a local .env into process.env (no-op if the file is absent, e.g. on the host)
import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put it in a local .env file, or the host env, before starting.');
}

// A pool reuses connections rather than opening one per query, which matters on serverless Postgres
// where the connection count is capped. ssl is required by Neon.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

// Thin query helper so the rest of the server never touches the pool directly.
export function query(text, params) {
  return pool.query(text, params);
}

// Create the users table once, if it does not already exist. Passwords are stored ONLY as a hash
// (added in the auth build); this build just proves the connection and the table.
export async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      games_won     INTEGER NOT NULL DEFAULT 0,
      games_lost    INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('Database ready (users table ensured).');
}
