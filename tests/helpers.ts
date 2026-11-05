import { DatabaseSync } from 'node:sqlite';
import { localDb } from '../lib/db-local.ts';
import type { SqlDriver, SqlValue } from '../lib/sql-driver.ts';
import type { KeyValueStore } from '../lib/auth-service.ts';

/** Драйвер на встроенном node:sqlite: те же миграции и триггеры, что в приложении, но в памяти. */
export function memoryDriver(): SqlDriver {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    async execute(sql: string, params: SqlValue[] = []) {
      db.prepare(sql).run(...params);
    },
    async select<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
  };
}

/** Чистая база в памяти для каждого теста (lib работает с общим экземпляром localDb). */
export async function freshDb(): Promise<void> {
  await localDb.useDriver(memoryDriver());
}

export function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}
