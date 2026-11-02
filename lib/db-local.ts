import Dexie, { Table } from 'dexie';

export interface LocalTask {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: 'todo' | 'in-progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  due_date: string | null;
  created_at: string;
  updated_at: string;
  synced: number; // 0 for false, 1 for true (IndexedDB prefers numbers for indexing)
}

export interface LocalSession {
  id: string;
  task_id: string;
  user_id: string;
  start_time: string;
  end_time: string | null;
  duration: number | null;
  synced: number; // 0 for false, 1 for true
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
  synced: number;
}

export class TaskaDatabase extends Dexie {
  tasks!: Table<LocalTask>;
  sessions!: Table<LocalSession>;
  blocks!: Table<LocalBlock>;

  constructor() {
    super('TaskaLocalDB');

    this.version(1).stores({
      tasks: 'id, user_id, status, synced',
      sessions: 'id, task_id, user_id, synced',
      blocks: 'id, session_id, task_id, synced',
    });
  }
}

export const db = new TaskaDatabase();
