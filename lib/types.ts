import { remainingFor } from './planner';
import type { PlanTask, TimedBlock } from './planner';

export type Priority = 'low' | 'medium' | 'high';
export type Status = 'backlog' | 'in_progress' | 'paused' | 'done';

export interface Task {
  id: string;
  workspace_id: string;
  title: string;
  estimate_min: number;
  priority: Priority;
  deadline: string | null;
  description: string | null;
  status: Status;
  spent_min: number;
  created_at: string;
  /** Исполнитель (id профиля). Всегда заполнен: у старых задач это владелец пространства. */
  assignee_id: string;
  /** Кто создал задачу: в cowork хост может ставить задачи другим. */
  created_by: string;
}

/** Участник рабочего пространства: хост или гость, присоединившийся в режиме cowork. */
export interface Participant {
  id: string;
  name: string;
  role: 'host' | 'member';
  /** false, если участника удалили, а его задачи остались */
  active: boolean;
}

export interface Session {
  id: string;
  workspace_id: string;
  user_id: string;
  window_min: number;
  started_at: string;
  ended_at: string | null;
}

export interface Block {
  id: string;
  session_id: string;
  task_id: string | null;
  position: number;
  kind: 'work' | 'break';
  planned_min: number;
  started_at: string;
  ended_at: string | null;
}

export interface Summary {
  workMin: number;
  done: string[];
  unfinished: string[];
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
};

export function toPlanTask(t: Task, current?: TimedBlock): PlanTask {
  return {
    id: t.id,
    priority: t.priority,
    deadline: t.deadline,
    createdAt: t.created_at,
    remaining: remainingFor(t, current),
  };
}
