import type { Block, Participant, Priority, Session, Task } from './types';

export interface NewTask {
  title: string;
  estimate_min: number;
  priority: Priority;
  deadline: string | null;
  description: string | null;
  /** Кому поставлена задача. Не указан — самому автору. */
  assignee_id?: string;
  /** Автор задачи. Заполняет хост по участнику соединения; значение от клиента игнорируется. */
  created_by?: string;
}

/** Поля задачи, которые разрешено менять снаружи (имена колонок попадают в SQL, поэтому список закрытый). */
export const TASK_FIELDS = ['title', 'estimate_min', 'priority', 'deadline', 'description', 'status', 'assignee_id'] as const;
export type TaskField = (typeof TASK_FIELDS)[number];
export type TaskPatch = Partial<Pick<Task, TaskField>>;

export interface NewBlock {
  task_id: string | null;
  position: number;
  kind: Block['kind'];
  planned_min: number;
  started_at: string;
}

/**
 * Всё, что интерфейс умеет делать с данными. Реализаций две:
 * локальная база (обычный режим и хост) и удалённая (гость cowork, запросы идут к хосту).
 */
export interface DataApi {
  getTasks(workspaceId: string): Promise<Task[]>;
  getTasksByIds(ids: string[]): Promise<Task[]>;
  createTask(workspaceId: string, input: NewTask): Promise<Task>;
  updateTask(id: string, patch: TaskPatch): Promise<void>;
  deleteTask(id: string): Promise<void>;

  getActiveSession(workspaceId: string, userId: string): Promise<Session | null>;
  createSession(workspaceId: string, userId: string, windowMin: number): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  /** Закрывает сессию; триггер finish_session разводит незавершённые задачи по «Пауза» и Backlog. */
  finishSession(id: string): Promise<void>;

  getBlocks(sessionId: string): Promise<Block[]>;
  insertBlocks(sessionId: string, blocks: NewBlock[]): Promise<void>;
  setBlockMinutes(id: string, minutes: number): Promise<void>;
  deleteBlocks(ids: string[]): Promise<void>;
  /** Завершает блок; триггер complete_block списывает время с задачи. Повторный вызов ничего не меняет. */
  completeBlock(id: string): Promise<void>;

  getParticipants(workspaceId: string): Promise<Participant[]>;
}

/** Api, который умеет сообщать об изменениях данных (свои и чужие), чтобы интерфейс перечитал список. */
export interface LiveApi extends DataApi {
  subscribe(listener: () => void): () => void;
}

export const MUTATING_METHODS = [
  'createTask',
  'updateTask',
  'deleteTask',
  'createSession',
  'deleteSession',
  'finishSession',
  'insertBlocks',
  'setBlockMinutes',
  'deleteBlocks',
  'completeBlock',
] as const satisfies readonly (keyof DataApi)[];

export const ALL_METHODS = [
  'getTasks',
  'getTasksByIds',
  'getActiveSession',
  'getBlocks',
  'getParticipants',
  ...MUTATING_METHODS,
] as const satisfies readonly (keyof DataApi)[];
