import { AppError } from './errors/app-error';
import { isTauri, openTauriDriver } from './sql-driver';
import type { SqlDriver, SqlValue } from './sql-driver';

/**
 * Миграции схемы. Номер версии хранится в PRAGMA user_version.
 * Каждая миграция идемпотентна (IF NOT EXISTS, проверка колонок перед ALTER), поэтому прерванный запуск можно безопасно повторить.
 * Новое изменение схемы — это новый элемент в конце массива, старые не правим.
 */
export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS local_profiles (
       id            TEXT PRIMARY KEY,
       email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
       nickname      TEXT NOT NULL UNIQUE COLLATE NOCASE,
       password_hash TEXT NOT NULL,
       created_at    TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS workspaces (
       id         TEXT PRIMARY KEY,
       name       TEXT NOT NULL DEFAULT 'Личное',
       owner_id   TEXT NOT NULL REFERENCES local_profiles(id) ON DELETE CASCADE,
       created_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS tasks (
       id           TEXT PRIMARY KEY,
       workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
       estimate_min INTEGER NOT NULL CHECK (estimate_min BETWEEN 5 AND 600 AND estimate_min % 5 = 0),
       priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
       deadline     TEXT,
       description  TEXT,
       status       TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'in_progress', 'paused', 'done')),
       spent_min    INTEGER NOT NULL DEFAULT 0 CHECK (spent_min >= 0),
       created_at   TEXT NOT NULL,
       updated_at   TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS tasks_workspace_status_idx ON tasks(workspace_id, status)`,
    `CREATE TABLE IF NOT EXISTS sessions (
       id           TEXT PRIMARY KEY,
       workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       user_id      TEXT NOT NULL REFERENCES local_profiles(id) ON DELETE CASCADE,
       window_min   INTEGER NOT NULL CHECK (window_min BETWEEN 30 AND 720 AND window_min % 5 = 0),
       started_at   TEXT NOT NULL,
       ended_at     TEXT
     )`,
    // У пользователя может быть только одна активная сессия
    `CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_active_per_user ON sessions(user_id) WHERE ended_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS session_blocks (
       id          TEXT PRIMARY KEY,
       session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
       task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
       position    INTEGER NOT NULL,
       kind        TEXT NOT NULL CHECK (kind IN ('work', 'break')),
       planned_min INTEGER NOT NULL CHECK (planned_min > 0),
       started_at  TEXT NOT NULL,
       ended_at    TEXT,
       UNIQUE (session_id, position)
     )`,
    `CREATE INDEX IF NOT EXISTS session_blocks_task_idx ON session_blocks(task_id)`,

    // Новый профиль сразу получает личное рабочее пространство (аналог handle_new_user из Postgres)
    `CREATE TRIGGER IF NOT EXISTS profile_creates_workspace AFTER INSERT ON local_profiles
     BEGIN
       INSERT INTO workspaces (id, name, owner_id, created_at)
       VALUES (lower(hex(randomblob(16))), 'Личное', NEW.id, NEW.created_at);
     END`,

    // Завершение рабочего блока: время списывается с задачи, при выполнении оценки она становится «Готово».
    // Триггер срабатывает один раз (когда ended_at впервые заполняется), поэтому повторный вызов безопасен.
    `CREATE TRIGGER IF NOT EXISTS complete_block AFTER UPDATE OF ended_at ON session_blocks
     WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL AND NEW.kind = 'work' AND NEW.task_id IS NOT NULL
     BEGIN
       UPDATE tasks
       SET spent_min  = spent_min + NEW.planned_min,
           status     = CASE WHEN spent_min + NEW.planned_min >= estimate_min THEN 'done' ELSE status END,
           updated_at = NEW.ended_at
       WHERE id = NEW.task_id;
     END`,

    // Завершение сессии: недоделанные задачи уходят в «Пауза» (если над ними работали) или обратно в Backlog
    `CREATE TRIGGER IF NOT EXISTS finish_session AFTER UPDATE OF ended_at ON sessions
     WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
     BEGIN
       UPDATE tasks
       SET status     = CASE WHEN spent_min > 0 THEN 'paused' ELSE 'backlog' END,
           updated_at = NEW.ended_at
       WHERE workspace_id = NEW.workspace_id AND status = 'in_progress';
     END`,
  ],

  // v2: режим cowork. Задача получает исполнителя, участники хранятся как профили особого вида.
  [
    // 'member' — участник чужого рабочего пространства: у него нет пароля и своего пространства, войти под ним нельзя
    `ALTER TABLE local_profiles ADD COLUMN kind TEXT NOT NULL DEFAULT 'account' CHECK (kind IN ('account', 'member'))`,
    `ALTER TABLE local_profiles ADD COLUMN display_name TEXT`,
    `ALTER TABLE workspaces ADD COLUMN cowork INTEGER NOT NULL DEFAULT 0 CHECK (cowork IN (0, 1))`,
    `ALTER TABLE workspaces ADD COLUMN invite_code TEXT`,
    // NULL в assignee_id/created_by у старых задач означает владельца пространства (см. TASK_SELECT в data-service)
    `ALTER TABLE tasks ADD COLUMN assignee_id TEXT`,
    `ALTER TABLE tasks ADD COLUMN created_by TEXT`,
    `CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks(workspace_id, assignee_id)`,
    `CREATE TABLE IF NOT EXISTS cowork_members (
       workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
       profile_id   TEXT NOT NULL REFERENCES local_profiles(id) ON DELETE CASCADE,
       token_hash   TEXT NOT NULL,
       joined_at    TEXT NOT NULL,
       PRIMARY KEY (workspace_id, profile_id)
     )`,

    // Личное пространство создаётся только настоящим аккаунтам, не участникам
    `DROP TRIGGER IF EXISTS profile_creates_workspace`,
    `CREATE TRIGGER profile_creates_workspace AFTER INSERT ON local_profiles WHEN NEW.kind = 'account'
     BEGIN
       INSERT INTO workspaces (id, name, owner_id, created_at)
       VALUES (lower(hex(randomblob(16))), 'Личное', NEW.id, NEW.created_at);
     END`,

    // Сессия затрагивает только задачи своего владельца, а не всех участников пространства
    `DROP TRIGGER IF EXISTS finish_session`,
    `CREATE TRIGGER finish_session AFTER UPDATE OF ended_at ON sessions
     WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
     BEGIN
       UPDATE tasks
       SET status     = CASE WHEN spent_min > 0 THEN 'paused' ELSE 'backlog' END,
           updated_at = NEW.ended_at
       WHERE workspace_id = NEW.workspace_id
         AND status = 'in_progress'
         AND COALESCE(assignee_id, (SELECT owner_id FROM workspaces WHERE id = NEW.workspace_id)) = NEW.user_id;
     END`,
  ],
];

const ADD_COLUMN_RE = /^\s*ALTER TABLE (\w+) ADD COLUMN (\w+)\b/i;

/**
 * Сервис локальной базы данных SQLite.
 * Драйвер подставляется при инициализации: в приложении это tauri-plugin-sql, в тестах — node:sqlite.
 */
export class LocalDBService {
  private driver: SqlDriver | null = null;
  private starting: Promise<void> | null = null;

  /** Открывает базу и применяет миграции. Безопасно вызывать несколько раз. */
  init(): Promise<void> {
    if (!this.starting) {
      this.starting = this.open().catch((e) => {
        this.starting = null; // дать возможность повторить после сбоя
        throw e;
      });
    }
    return this.starting;
  }

  /** Подключает готовый драйвер (для тестов). */
  async useDriver(driver: SqlDriver): Promise<void> {
    this.driver = driver;
    this.starting = this.migrate().catch((e) => {
      this.starting = null;
      throw e;
    });
    await this.starting;
  }

  private async open(): Promise<void> {
    if (!isTauri()) {
      throw new AppError(
        'Taska работает как десктопное приложение. Запустите его командой «npm run tauri dev».',
        'DESKTOP_ONLY',
        'critical',
      );
    }
    this.driver = await openTauriDriver();
    await this.migrate();
  }

  private async migrate(): Promise<void> {
    const rows = await this.query<{ user_version: number }>('PRAGMA user_version');
    const current = Number(rows[0]?.user_version ?? 0);
    for (let v = current; v < MIGRATIONS.length; v++) {
      for (const statement of MIGRATIONS[v]) {
        // ALTER ... ADD COLUMN сам по себе не идемпотентен: после прерванного запуска пропускаем уже добавленные колонки
        const add = ADD_COLUMN_RE.exec(statement);
        if (add) {
          const exists = await this.query('SELECT 1 FROM pragma_table_info(?) WHERE name = ?', [add[1], add[2]]);
          if (exists.length > 0) continue;
        }
        await this.execute(statement);
      }
      await this.execute(`PRAGMA user_version = ${v + 1}`);
    }
  }

  private get db(): SqlDriver {
    if (!this.driver) throw new AppError('База данных ещё не открыта', 'DB_NOT_READY', 'critical');
    return this.driver;
  }

  query<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.db.select<T>(sql, params);
  }

  execute(sql: string, params: SqlValue[] = []): Promise<void> {
    return this.db.execute(sql, params);
  }
}

export const localDb = new LocalDBService();
