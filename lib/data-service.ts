import { localDb, LocalTask, LocalSession } from './db-local';
import { v4 as uuidv4 } from 'uuid';

export const dataService = {
  /**
   * Получение всех задач из локальной БД.
   */
  async getTasks(workspaceId: string): Promise<LocalTask[]> {
    return await localDb.query<LocalTask>(
      'SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at DESC',
      [workspaceId]
    );
  },

  /**
   * Создание задачи в локальной БД.
   */
  async createTask(taskData: Partial<LocalTask>) {
    const newTask: LocalTask = {
      id: uuidv4(),
      workspace_id: taskData.workspace_id || '',
      title: taskData.title || 'Без названия',
      description: taskData.description || '',
      status: taskData.status || 'backlog',
      priority: taskData.priority || 'medium',
      due_date: taskData.due_date || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await localDb.execute(
      'INSERT INTO tasks (id, workspace_id, title, description, status, priority, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [newTask.id, newTask.workspace_id, newTask.title, newTask.description, newTask.status, newTask.priority, newTask.due_date, newTask.created_at, newTask.updated_at]
    );
    return newTask;
  },

  /**
   * Обновление задачи в локальной БД.
   */
  async updateTask(id: string, updates: Partial<LocalTask>) {
    const fields = Object.keys(updates).filter(k => k !== 'id');
    const values = fields.map(f => (updates as any)[f]);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    
    if (fields.length === 0) return;

    await localDb.execute(
      `UPDATE tasks SET ${setClause}, updated_at = ? WHERE id = ?`,
      [...values, new Date().toISOString(), id]
    );
  },

  /**
   * Удаление задачи.
   */
  async deleteTask(id: string) {
    await localDb.execute('DELETE FROM tasks WHERE id = ?', [id]);
  },

  /**
   * Работа с сессиями (Локально)
   */
  async startSession(taskId: string, workspaceId: string) {
    const session: LocalSession = {
      id: uuidv4(),
      task_id: taskId,
      workspace_id: workspaceId,
      start_time: new Date().toISOString(),
      end_time: null,
      duration: null,
    };

    await localDb.execute(
      'INSERT INTO sessions (id, task_id, workspace_id, start_time, end_time, duration) VALUES (?, ?, ?, ?, ?, ?)',
      [session.id, session.task_id, session.workspace_id, session.start_time, session.end_time, session.duration]
    );
    return session;
  },

  async stopSession(sessionId: string) {
    const sessions = await localDb.query<LocalSession>('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    const session = sessions[0];
    if (!session) throw new Error('Session not found');

    const endTime = new Date().toISOString();
    const start = new Date(session.start_time).getTime();
    const end = new Date(endTime).getTime();
    const duration = Math.floor((end - start) / (1000 * 60)); // duration in minutes

    await localDb.execute(
      'UPDATE sessions SET end_time = ?, duration = ? WHERE id = ?',
      [endTime, duration, sessionId]
    );
  },

  /**
   * Работа с блоками сессий (Локально)
   */
  async getBlocks(sessionId: string): Promise<any[]> {
    return await localDb.query(
      'SELECT * FROM session_blocks WHERE session_id = ? ORDER BY position',
      [sessionId]
    );
  },

  async updateBlock(id: string, updates: any) {
    const fields = Object.keys(updates);
    const values = fields.map(f => updates[f]);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    
    await localDb.execute(
      `UPDATE session_blocks SET ${setClause} WHERE id = ?`,
      [...values, id]
    );
  },

  async deleteBlocks(ids: string[]) {
    // SQLite doesn't support .in() like Supabase, using a loop or dynamic query
    for (const id of ids) {
      await localDb.execute('DELETE FROM session_blocks WHERE id = ?', [id]);
    }
  },

  async insertBlocks(blocks: any[]) {
    for (const b of blocks) {
      await localDb.execute(
        'INSERT INTO session_blocks (id, session_id, task_id, position, kind, planned_min, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [b.id || uuidv4(), b.session_id, b.task_id, b.position, b.kind, b.planned_min, b.started_at, b.ended_at]
      );
    }
  }
};
