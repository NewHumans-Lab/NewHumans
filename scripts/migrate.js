import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db.js';
import {
  validateAppliedMigrationMetadata,
  validateMigrationFiles,
} from './migration-order.js';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const files = validateMigrationFiles(await fs.readdir(dir));

const pool = createPool();
try {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS meta; CREATE TABLE IF NOT EXISTS meta.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const appliedResult = await pool.query('SELECT name FROM meta.schema_migrations');
  const applied = validateAppliedMigrationMetadata(files, appliedResult.rows);

  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await fs.readFile(path.join(dir, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO meta.schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
