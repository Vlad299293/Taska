/**
 * Минимальный интерфейс доступа к SQLite.
 * В приложении его реализует tauri-plugin-sql, в тестах — встроенный node:sqlite.
 */
export type SqlValue = string | number | null;

export interface SqlDriver {
  execute(sql: string, params?: SqlValue[]): Promise<void>;
  select<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
}

/** Файл базы лежит в папке данных приложения (AppData на Windows). */
export const DB_URL = 'sqlite:taska.db';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function openTauriDriver(): Promise<SqlDriver> {
  // Импорт отложен: в обычном браузере (и при сборке Next.js) плагин не нужен
  const { default: Database } = await import('@tauri-apps/plugin-sql');
  const db = await Database.load(DB_URL);
  return {
    async execute(sql, params = []) {
      await db.execute(sql, params);
    },
    async select<T>(sql: string, params: SqlValue[] = []) {
      return await db.select<T[]>(sql, params);
    },
  };
}
