import type Database from "@tauri-apps/plugin-sql";
import { getRuntimePlatformSync } from "../platform";

export const MOBILE_DATABASE_URL = "sqlite:scisonomics-mobile.db";
let connection: Promise<Database> | undefined;

export async function getMobileDatabase(): Promise<Database> {
  const platform = getRuntimePlatformSync();
  if (platform !== "android" && platform !== "ios") {
    throw new Error("Mobile SQLite is only available in the mobile Tauri runtime.");
  }
  if (!connection) {
    connection = openDatabase().catch((error) => {
      connection = undefined;
      throw error;
    });
  }
  return connection;
}

async function openDatabase(): Promise<Database> {
  let database: Database | undefined;
  try {
    const { default: Database } = await import("@tauri-apps/plugin-sql");
    database = await Database.load(MOBILE_DATABASE_URL);
    // SQLx enables this on every pooled connection; fail closed if it does not.
    const foreignKeys = await database.select<{ foreign_keys: number }[]>("PRAGMA foreign_keys");
    const migrations = await database.select<{ version: number; success: number }[]>(
      "SELECT version, success FROM _sqlx_migrations WHERE version IN ($1, $2, $3) ORDER BY version", [1, 2, 3],
    );
    if (foreignKeys[0]?.foreign_keys !== 1 || migrations.length !== 3 || migrations[0]?.version !== 1 || !migrations[0]?.success || migrations[1]?.version !== 2 || !migrations[1]?.success || migrations[2]?.version !== 3 || !migrations[2]?.success) {
      throw new Error("Mobile schema was not initialized correctly.");
    }
    return database;
  } catch {
    await database?.close().catch(() => {});
    throw new Error("No se pudo abrir el almacenamiento local. Reintentá sin borrar los datos de la app.");
  }
}
