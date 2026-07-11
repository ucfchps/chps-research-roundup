import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export async function runMigrations(client: Client, migrationsDir = MIGRATIONS_DIR) {
  await client.execute("PRAGMA foreign_keys = ON");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    (await client.execute("SELECT name FROM _migrations")).rows.map(
      (row) => row.name as string
    )
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const pending = files.filter((f) => !applied.has(f));

  for (const file of pending) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf-8");
    await client.executeMultiple(sql);
    await client.execute({
      sql: "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
      args: [file, new Date().toISOString()],
    });
    console.log(`Applied ${file}`);
  }

  if (pending.length === 0) {
    console.log("No pending migrations.");
  }

  return pending;
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error(
      "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)"
    );
  }

  const client = createClient({ url, authToken });
  await runMigrations(client);
}

if (require.main === module) {
  main();
}
