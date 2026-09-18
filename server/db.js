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

// Create/upgrade the schema. Safe to run on every boot: CREATE IF NOT EXISTS for new databases,
// ALTER ... ADD COLUMN IF NOT EXISTS to upgrade an existing users table without touching its rows.
export async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      points        INTEGER NOT NULL DEFAULT 0,   -- lifetime net points (zero-sum across all accounts)
      deals_won     INTEGER NOT NULL DEFAULT 0,
      deals_lost    INTEGER NOT NULL DEFAULT 0,
      rubbers_won   INTEGER NOT NULL DEFAULT 0,
      rubbers_lost  INTEGER NOT NULL DEFAULT 0,
      avatar_url    TEXT,
      avatar_blocked BOOLEAN NOT NULL DEFAULT false,
      card_back_url TEXT,
      card_back_blocked BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS points        INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS deals_won     INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS deals_lost    INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS rubbers_won   INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS rubbers_lost  INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url    TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_blocked BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS card_back_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS card_back_blocked BOOLEAN NOT NULL DEFAULT false;

    CREATE TABLE IF NOT EXISTS matches (
      id         SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ns_score   INTEGER NOT NULL,
      ew_score   INTEGER NOT NULL,
      winner     TEXT,                 -- 'NS' | 'EW'
      seats      JSONB NOT NULL,       -- { N:{userId,username}|null, E, S, W }
      rounds     JSONB NOT NULL,       -- the per-deal scoreboard for this rubber
      players    INTEGER[] NOT NULL    -- user ids who were seated (for "my history" filtering)
    );
  `);
  console.log('Database ready (users + matches ensured).');
}
