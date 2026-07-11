import { createClient, type InArgs, type Row } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  throw new Error(
    "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (see .env.example)"
  );
}

export const client = createClient({ url, authToken });
void client.execute("PRAGMA foreign_keys = ON");

export async function query<T = Row>(sql: string, args: InArgs = []): Promise<T[]> {
  const result = await client.execute({ sql, args });
  return result.rows as unknown as T[];
}

export async function execute(sql: string, args: InArgs = []) {
  return client.execute({ sql, args });
}
