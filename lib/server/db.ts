import "server-only";
import postgres from "postgres";

// Direkte Postgres-tilkobling til Supabase (transaction pooler). Kun server-side.
// prepare: false er påkrevd med transaction pooler. Tilkoblingen åpnes først ved første spørring.
const globalForDb = globalThis as unknown as { sql?: postgres.Sql };

if (!process.env.DATABASE_URL) console.warn("DATABASE_URL mangler – databasekall vil feile");

export const sql =
  globalForDb.sql ?? postgres(process.env.DATABASE_URL ?? "", { prepare: false, max: 5, idle_timeout: 20 });

if (process.env.NODE_ENV !== "production") globalForDb.sql = sql;

/** Lagrer en verdi som jsonb (fjerner undefined, gir postgres.js en ren JSON-verdi). */
export const asJson = (value: unknown) => sql.json(JSON.parse(JSON.stringify(value ?? null)));
