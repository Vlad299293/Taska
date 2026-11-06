import { localDb } from './db-local';
import { TASK_FIELDS } from './data-api';
import type { DataApi, NewBlock, NewTask, TaskPatch } from './data-api';
import type { SqlValue } from './sql-driver';
import type { Block, Participant, Session, Task } from './types';

export type { NewBlock, NewTask, TaskPatch };

/**
 * Задачи читаются с исполнителем и автором. У задач, созданных до режима cowork, эти поля пустые,
 * и они принадлежат владельцу пространства.
 */
const TASK_SELECT = `
  SELECT t.id, t.workspace_id, t.title, t.estimate_min, t.priority, t.deadline, t.description,
         t.status, t.spent_min, t.created_at,
         COALESCE(t.assignee_id, w.owner_id) AS assignee_id,
         COALESCE(t.created_by, w.owner_id) AS created_by
  FROM tasks t
  JOIN workspaces w ON w.id = t.workspace_id`;

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export interface WorkspaceInfo {
  id: string;
  name: string;
  ownerId: string;
  cowork: boolean;
  inviteCode: string | null;
}

/** Локальная база: единственное место, где данные меняются по-настоящему (у гостя cowork запросы идут к хосту). */
export const dataService = {
  // ---------- Задачи ----------

  getTasks(workspaceId: string): Promise<Task[]> {
    return localDb.query<Task>(`${TASK_SELECT} WHERE t.workspace_id = ? ORDER BY t.created_at, t.id`, [workspaceId]);
  },

  async getTasksByIds(ids: string[]): Promise<Task[]> {
    if (ids.length === 0) return [];
    return localDb.query<Task>(`${TASK_SELECT} WHERE t.id IN (${placeholders(ids.length)})`, ids);
  },

  async createTask(workspaceId: string, input: NewTask & { created_by?: string }): Promise<Task> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await localDb.execute(
      `INSERT INTO tasks (id, workspace_id, title, estimate_min, priority, deadline, description, status, spent_min, created_at, updated_at, assignee_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'backlog', 0, ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        input.title,
        input.estimate_min,
        input.priority,
        input.deadline,
        input.description,
        now,
        now,
        input.assignee_id ?? null,
        input.created_by ?? null,
      ],
    );
    const [created] = await dataService.getTasksByIds([id]);
    return created;
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

  async completeBlock(id: string): Promise<void> {
    await localDb.execute('UPDATE session_blocks SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [new Date().toISOString(), id]);
  },

  // ---------- Участники и cowork ----------

  /**
   * Хост и участники пространства. Удалённые участники остаются в списке (active = false),
   * пока у них есть задачи, чтобы у задачи всегда было видно, чья она.
   */
  async getParticipants(workspaceId: string): Promise<Participant[]> {
    const rows = await localDb.query<{ id: string; name: string; role: 'host' | 'member'; active: number }>(
      `SELECT p.id AS id,
              COALESCE(p.display_name, p.nickname) AS name,
              CASE WHEN p.id = w.owner_id THEN 'host' ELSE 'member' END AS role,
              CASE WHEN p.id = w.owner_id OR m.profile_id IS NOT NULL THEN 1 ELSE 0 END AS active
       FROM workspaces w
       JOIN local_profiles p
         ON p.id = w.owner_id
         OR p.id IN (SELECT profile_id FROM cowork_members WHERE workspace_id = w.id)
         OR p.id IN (SELECT assignee_id FROM tasks WHERE workspace_id = w.id AND assignee_id IS NOT NULL)
       LEFT JOIN cowork_members m ON m.workspace_id = w.id AND m.profile_id = p.id
       WHERE w.id = ?
       ORDER BY (p.id = w.owner_id) DESC, p.created_at, p.id`,
      [workspaceId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, active: r.active === 1 }));
  },

  async getWorkspace(workspaceId: string): Promise<WorkspaceInfo> {
    const [row] = await localDb.query<{ id: string; name: string; owner_id: string; cowork: number; invite_code: string | null }>(
      'SELECT id, name, owner_id, cowork, invite_code FROM workspaces WHERE id = ?',
      [workspaceId],
    );
    if (!row) throw new Error('Рабочее пространство не найдено');
    return { id: row.id, name: row.name, ownerId: row.owner_id, cowork: row.cowork === 1, inviteCode: row.invite_code };
  },

  async setCowork(workspaceId: string, enabled: boolean, inviteCode: string | null): Promise<void> {
    await localDb.execute('UPDATE workspaces SET cowork = ?, invite_code = ? WHERE id = ?', [enabled ? 1 : 0, inviteCode, workspaceId]);
  },

  /** Создаёт профиль участника и запись о членстве. Возвращает id нового профиля. */
  async addMember(workspaceId: string, displayName: string, tokenHash: string): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await localDb.execute(
      `INSERT INTO local_profiles (id, email, nickname, password_hash, created_at, kind, display_name)
       VALUES (?, ?, ?, '!', ?, 'member', ?)`,
      [id, `member-${id}@cowork.invalid`, `m-${id.slice(0, 8)}`, now, displayName],
    );
    await localDb.execute('INSERT INTO cowork_members (workspace_id, profile_id, token_hash, joined_at) VALUES (?, ?, ?, ?)', [
      workspaceId,
      id,
      tokenHash,
      now,
    ]);
    return id;
  },

  async removeMember(workspaceId: string, profileId: string): Promise<void> {
    await localDb.execute('DELETE FROM cowork_members WHERE workspace_id = ? AND profile_id = ?', [workspaceId, profileId]);
  },

  async getMemberTokenHash(workspaceId: string, profileId: string): Promise<string | null> {
    const rows = await localDb.query<{ token_hash: string }>(
      'SELECT token_hash FROM cowork_members WHERE workspace_id = ? AND profile_id = ?',
      [workspaceId, profileId],
    );
    return rows[0]?.token_hash ?? null;
  },

  // ---------- Владельцы (для проверки прав хостом) ----------

  async getTaskInfo(id: string): Promise<{ assignee_id: string; status: Task['status']; workspace_id: string } | null> {
    const rows = await localDb.query<{ assignee_id: string; status: Task['status']; workspace_id: string }>(
      'SELECT COALESCE(t.assignee_id, w.owner_id) AS assignee_id, t.status, t.workspace_id FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ?',
      [id],
    );
    return rows[0] ?? null;
  },

  async getSessionOwner(id: string): Promise<string | null> {
    const rows = await localDb.query<{ user_id: string }>('SELECT user_id FROM sessions WHERE id = ?', [id]);
    return rows[0]?.user_id ?? null;
  },

  async getBlockOwner(id: string): Promise<string | null> {
    const rows = await localDb.query<{ user_id: string }>(
      'SELECT s.user_id FROM session_blocks b JOIN sessions s ON s.id = b.session_id WHERE b.id = ?',
      [id],
    );
    return rows[0]?.user_id ?? null;
  },
} satisfies DataApi & Record<string, unknown>;
