import fs from 'node:fs/promises';
import path from 'node:path';
import { createPool } from '../src/db.js';

const pool = createPool();
try {
  const dir = new URL('../migrations/', import.meta.url);
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  await pool.query(`CREATE SCHEMA IF NOT EXISTS meta; CREATE TABLE IF NOT EXISTS meta.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const name of files) {
    const done = await pool.query('SELECT 1 FROM meta.schema_migrations WHERE name=$1', [name]);
    if (done.rowCount) continue;
    const sql = await fs.readFile(path.join(dir.pathname, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(sql); await client.query('INSERT INTO meta.schema_migrations (name) VALUES ($1)', [name]); await client.query('COMMIT'); console.log(`applied ${name}`);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
} finally { await pool.end(); }
