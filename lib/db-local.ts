/**
 * Интерфейс для локального профиля пользователя в SQLite
 */
export interface LocalProfile {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  created_at: string;
}

export interface LocalTask {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface LocalSession {
  id: string;
  task_id: string;
  workspace_id: string;
  start_time: string;
  end_time: string | null;
  duration: number | null;
}

export interface LocalBlock {
  id: string;
  session_id: string;
  task_id: string;
  position: number;
  kind: 'work' | 'break';
  planned_min: number;
  started_at: string;
  ended_at: string | null;
}

/**
 * Сервис управления локальной базой данных SQLite.
 * Для работы в Tauri используется tauri-plugin-sql.
 */
export class LocalDBService {
  private db: any = null;
  private readonly dbName = 'taska.db';

  async init() {
    try {
      // В Tauri плагин sql доступен через window.__TAURI__.plugin
      // Используем динамическую проверку среды, чтобы билд Next.js не падал
      if (typeof window !== 'undefined' && (window as any).__TAURI__) {
        // Динамический импорт API плагина только в рантайме Tauri
        const { Database } = await import('tauri-plugin-sql-api');
        this.db = await Database.load(this.dbName);
      } else {
        console.warn('[LocalDB] Tauri environment not detected. Using mock DB for build/web.');
        this.db = {
          execute: async () => { return []; },
          select: async () => { return []; }
        };
      }
      await this.createTables();
    } catch (e) {
      console.error('[LocalDB] Initialization failed:', e);
    }
  }

  private async createTables() {
    if (!this.db) return;
    const schema = [
      `CREATE TABLE IF NOT EXISTS local_profiles (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, display_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`,
      `CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT, owner_id TEXT, invite_code TEXT UNIQUE, is_host BOOLEAN);`,
      `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, description TEXT, status TEXT, priority TEXT, due_date DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);`,
      `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task_id TEXT, workspace_id TEXT, start_time DATETIME, end_time DATETIME, duration INTEGER);`,
      `CREATE TABLE IF NOT EXISTS session_blocks (id TEXT PRIMARY KEY, session_id TEXT, task_id TEXT, position INTEGER, kind TEXT, planned_min INTEGER, started_at DATETIME, ended_at DATETIME);`
    ];
    for (const query of schema) {
      await this.db.execute(query);
    }
  }

  async query<T = any>(sql: string, bind: any[] = []): Promise<T[]> {
    if (!this.db) return [];
    return await this.db.select(sql, bind);
  }

  async execute(sql: string, bind: any[] = []): Promise<void> {
    if (!this.db) return;
    await this.db.execute(sql, bind);
  }
}

export const localDb = new LocalDBService();
