import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";

export const pool = new pg.Pool({ connectionString: env.databaseUrl });

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(4242)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

    const dir = path.join(import.meta.dirname, "..", "migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`migrated ${file}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(4242)");
    client.release();
  }
}