import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env and set it.');
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const directory = path.dirname(fileURLToPath(import.meta.url));

try {
  const migrationDirectory = path.join(directory, '..', 'db');
  const migrations = (await readdir(migrationDirectory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const migration of migrations) await pool.query(await readFile(path.join(migrationDirectory, migration), 'utf8'));
  console.log('Migration completed.');
} finally { await pool.end(); }
