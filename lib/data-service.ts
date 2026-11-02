import { db, LocalTask, LocalSession } from './db-local';
import { supabase } from './supabase';
import { syncEngine } from './sync-engine';
import { v4 as uuidv4 } from 'uuid';

export interface LocalBlock {
  id: string;
  session_id: string;
  task_id: string;
  position: number;
  kind: 'work' | 'break';
  planned_min: number;
  started_at: string;
  ended_at: string | null;
  synced: number;
}

export const dataService = {
  /**
   * Получение всех задач.
   */
  async getTasks(): Promise<LocalTask[]> {
    const localTasks = await db.tasks.toArray();
    syncEngine.synchronize().catch(console.error);
    return localTasks;
  },

  /**
   * Создание задачи.
   */
  async createTask(taskData: Partial<LocalTask>) {
    const newTask: LocalTask = {
      id: uuidv4(),
      user_id: taskData.user_id || '',
      title: taskData.title || 'Без названия',
      description: taskData.description || '',
      status: taskData.status || 'todo',
      priority: taskData.priority || 'medium',
      due_date: taskData.due_date || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      synced: 0,
    };

    await db.tasks.add(newTask);
    syncEngine.synchronize().catch(console.error);
    return newTask;
  },

  /**
   * Обновление задачи.
   */
  async updateTask(id: string, updates: Partial<LocalTask>) {
    const updatedAt = new Date().toISOString();
    await db.tasks.update(id, {
      ...updates,
      updated_at: updatedAt,
      synced: 0,
    });
    syncEngine.synchronize().catch(console.error);
  },

  /**
   * Удаление задачи.
   */
  async deleteTask(id: string) {
    await db.tasks.delete(id);
    await supabase.from('tasks').delete().eq('id', id);
  },

  /**
   * Работа с сессиями
   */
  async startSession(taskId: string, userId: string) {
    const session = {
      id: uuidv4(),
      task_id: taskId,
      user_id: userId,
      start_time: new Date().toISOString(),
      end_time: null,
      duration: null,
      synced: 0,
    };

    await db.sessions.add(session);
    syncEngine.synchronize().catch(console.error);
    return session;
  },

  async stopSession(sessionId: string) {
    const session = await db.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const endTime = new Date().toISOString();
    const start = new Date(session.start_time);
    const end = new Date(endTime);
    const duration = Math.floor((end.getTime() - start.getTime()) / 1000);

    await db.sessions.update(sessionId, {
      end_time: endTime,
      duration: duration,
      synced: 0,
    });

    syncEngine.synchronize().catch(console.error);
  },

  /**
   * Работа с блоками сессий
   */
  async getBlocks(sessionId: string): Promise<any[]> {
    // Временно возвращаем данные из supabase, так как в LocalDB еще нет таблицы blocks
    // В следующем шаге добавим её в db-local.ts
    const { data } = await supabase.from('session_blocks').select('*').eq('session_id', sessionId).order('position');
    return data || [];
  },

  async updateBlock(id: string, updates: any) {
    await supabase.from('session_blocks').update(updates).eq('id', id);
  },

  async deleteBlocks(ids: string[]) {
    await supabase.from('session_blocks').delete().in('id', ids);
  },

  async insertBlocks(blocks: any[]) {
    await supabase.from('session_blocks').insert(blocks);
  }
};
