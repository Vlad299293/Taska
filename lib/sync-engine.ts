import { db, LocalTask, LocalSession } from './db-local';
import { supabase } from './supabase';

export class SyncEngine {
  /**
   * Синхронизирует локальные изменения с облаком (Push)
   */
  async pushLocalChanges() {
    console.log('SyncEngine: Pushing local changes to cloud...');

    // 1. Синхронизация задач
    const unsyncedTasks = await db.tasks.where('synced').equals(0).toArray();
    for (const task of unsyncedTasks) {
      try {
        const { error } = await supabase
          .from('tasks')
          .upsert({
            id: task.id,
            user_id: task.user_id,
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority,
            due_date: task.due_date,
            updated_at: task.updated_at,
          });

        if (!error) {
          await db.tasks.update(task.id, { synced: 1 });
        } else {
          console.error(`SyncEngine: Error pushing task ${task.id}:`, error);
        }
      } catch (e) {
        console.error(`SyncEngine: Exception pushing task ${task.id}:`, e);
      }
    }

    // 2. Синхронизация сессий
    const unsyncedSessions = await db.sessions.where('synced').equals(0).toArray();
    for (const session of unsyncedSessions) {
      try {
        const { error } = await supabase
          .from('sessions')
          .upsert({
            id: session.id,
            task_id: session.task_id,
            user_id: session.user_id,
            start_time: session.start_time,
            end_time: session.end_time,
            duration: session.duration,
          });

        if (!error) {
          await db.sessions.update(session.id, { synced: 1 });
        } else {
          console.error(`SyncEngine: Error pushing session ${session.id}:`, error);
        }
      } catch (e) {
        console.error(`SyncEngine: Exception pushing session ${session.id}:`, e);
      }
    }
  }

  /**
   * Загружает обновления из облака в локальную БД (Pull)
   * @param lastSyncTimestamp ISO string of the last successful sync
   */
  async pullCloudChanges(lastSyncTimestamp: string) {
    console.log(`SyncEngine: Pulling changes since ${lastSyncTimestamp}...`);

    // 1. Загрузка задач
    const { data: tasks, error: tasksError } = await supabase
      .from('tasks')
      .select('*')
      .gt('updated_at', lastSyncTimestamp);

    if (!tasksError && tasks) {
      await db.tasks.bulkPut(
        tasks.map(t => ({
          ...t,
          synced: 1,
        }))
      );
    }

    // 2. Загрузка сессий
    const { data: sessions, error: sessionsError } = await supabase
      .from('sessions')
      .select('*')
      .gt('updated_at', lastSyncTimestamp);

    if (!sessionsError && sessions) {
      await db.sessions.bulkPut(
        sessions.map(s => ({
          ...s,
          synced: 1,
        }))
      );
    }
  }

  /**
   * Полный цикл синхронизации
   */
  async synchronize() {
    try {
      await this.pushLocalChanges();

      // Получаем дату последней синхронизации из localStorage или используем старую дату
      const lastSync = localStorage.getItem('last_sync_timestamp') || '1970-01-01T00:00:00Z';
      await this.pullCloudChanges(lastSync);

      localStorage.setItem('last_sync_timestamp', new Date().toISOString());
      console.log('SyncEngine: Synchronization complete.');
    } catch (e) {
      console.error('SyncEngine: Critical sync error:', e);
    }
  }
}

export const syncEngine = new SyncEngine();
