import { localDb } from './db-local';
import type { SqlValue } from './sql-driver';
import type { Block, Priority, Session, Status, Task } from './types';

/** Поля задачи, которые разрешено менять снаружи (имена колонок попадают в SQL, поэтому список закрытый). */
const TASK_FIELDS = ['title', 'estimate_min', 'priority', 'deadline', 'description', 'status'] as const;
type TaskField = (typeof TASK_FIELDS)[number];

export interface NewTask {
  title: string;
  estimate_min: number;
  priority: Priority;
  deadline: string | null;
  description: string | null;
}

export type TaskPatch = Partial<Pick<Task, TaskField>>;

export interface NewBlock {
  task_id: string | null;
  position: number;
  kind: Block['kind'];
  planned_min: number;
  started_at: string;
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export const dataService = {
  // ---------- Задачи ----------

  getTasks(workspaceId: string): Promise<Task[]> {
    return localDb.query<Task>('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at, id', [workspaceId]);
  },

  async getTasksByIds(ids: string[]): Promise<Task[]> {
    if (ids.length === 0) return [];
    return localDb.query<Task>(`SELECT * FROM tasks WHERE id IN (${placeholders(ids.length)})`, ids);
  },

  async createTask(workspaceId: string, input: NewTask): Promise<Task> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await localDb.execute(
      `INSERT INTO tasks (id, workspace_id, title, estimate_min, priority, deadline, description, status, spent_min, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'backlog', 0, ?, ?)`,
      [id, workspaceId, input.title, input.estimate_min, input.priority, input.deadline, input.description, now, now],
    );
    return {
      id,
      workspace_id: workspaceId,
      title: input.title,
      estimate_min: input.estimate_min,
      priority: input.priority,
      deadline: input.deadline,
      description: input.description,
      status: 'backlog' as Status,
      spent_min: 0,
      created_at: now,
    };
  },

  async updateTask(id: string, patch: TaskPatch): Promise<void> {
    const fields = TASK_FIELDS.filter((f) => patch[f] !== undefined);
    if (fields.length === 0) return;
    const set = fields.map((f) => `${f} = ?`).join(', ');
    const values = fields.map((f) => patch[f] as SqlValue);
    await localDb.execute(`UPDATE tasks SET ${set}, updated_at = ? WHERE id = ?`, [...values, new Date().toISOString(), id]);
  },

  async deleteTask(id: string): Promise<void> {
    await localDb.execute('DELETE FROM tasks WHERE id = ?', [id]);
  },

  // ---------- Сессии ----------

  async getActiveSession(workspaceId: string, userId: string): Promise<Session | null> {
    const rows = await localDb.query<Session>(
      'SELECT * FROM sessions WHERE workspace_id = ? AND user_id = ? AND ended_at IS NULL LIMIT 1',
      [workspaceId, userId],
    );
    return rows[0] ?? null;
  },

  async createSession(workspaceId: string, userId: string, windowMin: number): Promise<Session> {
    const session: Session = {
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      user_id: userId,
      window_min: windowMin,
      started_at: new Date().toISOString(),
      ended_at: null,
    };
    await localDb.execute('INSERT INTO sessions (id, workspace_id, user_id, window_min, started_at) VALUES (?, ?, ?, ?, ?)', [
      session.id,
      session.workspace_id,
      session.user_id,
      session.window_min,
      session.started_at,
    ]);
    return session;
  },

  async deleteSession(id: string): Promise<void> {
    await localDb.execute('DELETE FROM sessions WHERE id = ?', [id]);
  },

  /** Закрывает сессию; триггер finish_session разводит незавершённые задачи по «Пауза» и Backlog. */
  async finishSession(id: string): Promise<void> {
    await localDb.execute('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [new Date().toISOString(), id]);
  },

  // ---------- Блоки ----------

  getBlocks(sessionId: string): Promise<Block[]> {
    return localDb.query<Block>('SELECT * FROM session_blocks WHERE session_id = ? ORDER BY position', [sessionId]);
  },

  async insertBlocks(sessionId: string, blocks: NewBlock[]): Promise<void> {
    for (const b of blocks) {
      await localDb.execute(
        'INSERT INTO session_blocks (id, session_id, task_id, position, kind, planned_min, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), sessionId, b.task_id, b.position, b.kind, b.planned_min, b.started_at],
      );
    }
  },

  async setBlockMinutes(id: string, minutes: number): Promise<void> {
    await localDb.execute('UPDATE session_blocks SET planned_min = ? WHERE id = ?', [minutes, id]);
  },

  async deleteBlocks(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await localDb.execute(`DELETE FROM session_blocks WHERE id IN (${placeholders(ids.length)})`, ids);
  },

  /**
   * Завершает блок; триггер complete_block списывает время с задачи и при необходимости переводит её в «Готово».
   * Повторный вызов для того же блока ничего не меняет.
   */
  async completeBlock(id: string): Promise<void> {
    await localDb.execute('UPDATE session_blocks SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [new Date().toISOString(), id]);
  },
};
