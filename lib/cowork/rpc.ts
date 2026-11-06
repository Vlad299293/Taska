import { TASK_FIELDS } from '../data-api';
import type { DataApi, NewBlock, NewTask, TaskPatch } from '../data-api';
import { dataService } from '../data-service';
import { CoworkError } from './protocol';

/**
 * Выполнение запроса гостя на хосте. Здесь живут все правила доступа cowork:
 *  - видеть задачи и участников могут все;
 *  - хост создаёт задачи кому угодно, участник только себе;
 *  - менять и удалять чужую задачу может только хост, но статус задачи меняет только её исполнитель;
 *  - сессии, блоки и таймер у каждого свои;
 *  - задачу можно передать другому, только пока над ней не работали.
 */
export interface RpcContext {
  workspaceId: string;
  callerId: string;
  isHost: boolean;
}

const bad = (message: string) => new CoworkError(message, 'BAD_REQUEST');
const forbidden = (message: string) => new CoworkError(message, 'FORBIDDEN');

function str(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) throw bad(`Некорректный параметр: ${what}`);
  return value;
}

function num(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(`Некорректный параметр: ${what}`);
  return value;
}

function nullableStr(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 5000) throw bad(`Некорректный параметр: ${what}`);
  return value;
}

function strList(value: unknown, what: string, max = 500): string[] {
  if (!Array.isArray(value) || value.length > max) throw bad(`Некорректный параметр: ${what}`);
  return value.map((v) => str(v, what));
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad(`Некорректный параметр: ${what}`);
  return value as Record<string, unknown>;
}

export async function executeRpc(api: DataApi, ctx: RpcContext, method: string, args: unknown[]): Promise<unknown> {
  const sameWorkspace = (value: unknown) => {
    if (str(value, 'workspaceId') !== ctx.workspaceId) throw forbidden('Это не ваше рабочее пространство');
  };

  const requireActiveParticipant = async (id: string) => {
    const list = await api.getParticipants(ctx.workspaceId);
    if (!list.some((p) => p.id === id && p.active)) throw bad('Такого участника нет в рабочем пространстве');
  };

  const requireTask = async (id: string) => {
    const info = await dataService.getTaskInfo(id);
    if (!info || info.workspace_id !== ctx.workspaceId) throw new CoworkError('Задача не найдена', 'NOT_FOUND');
    return info;
  };

  const requireOwnSession = async (sessionId: string) => {
    const owner = await dataService.getSessionOwner(sessionId);
    if (owner === null) throw new CoworkError('Сессия не найдена', 'NOT_FOUND');
    if (owner !== ctx.callerId) throw forbidden('Это чужая сессия');
  };

  const requireOwnBlock = async (blockId: string) => {
    const owner = await dataService.getBlockOwner(blockId);
    if (owner === null) throw new CoworkError('Блок не найден', 'NOT_FOUND');
    if (owner !== ctx.callerId) throw forbidden('Это чужой блок');
  };

  switch (method) {
    case 'getTasks':
      sameWorkspace(args[0]);
      return api.getTasks(ctx.workspaceId);

    case 'getTasksByIds': {
      const ids = strList(args[0], 'ids', 200);
      return (await api.getTasksByIds(ids)).filter((t) => t.workspace_id === ctx.workspaceId);
    }

    case 'getParticipants':
      sameWorkspace(args[0]);
      return api.getParticipants(ctx.workspaceId);

    case 'createTask': {
      sameWorkspace(args[0]);
      const input = record(args[1], 'task');
      const assignee = input.assignee_id === undefined ? ctx.callerId : str(input.assignee_id, 'assignee_id');
      if (!ctx.isHost && assignee !== ctx.callerId) throw forbidden('Участник может создавать задачи только для себя');
      await requireActiveParticipant(assignee);
      // Поля перечислены явно: лишнее от клиента (например, created_by) отбрасывается
      const clean: NewTask = {
        title: str(input.title, 'title'),
        estimate_min: num(input.estimate_min, 'estimate_min'),
        priority: str(input.priority, 'priority') as NewTask['priority'],
        deadline: nullableStr(input.deadline, 'deadline'),
        description: nullableStr(input.description, 'description'),
        assignee_id: assignee,
        created_by: ctx.callerId,
      };
      return api.createTask(ctx.workspaceId, clean);
    }

    case 'updateTask': {
      const id = str(args[0], 'id');
      const raw = record(args[1], 'patch');
      const info = await requireTask(id);
      const isOwner = info.assignee_id === ctx.callerId;
      if (!ctx.isHost && !isOwner) throw forbidden('Чужую задачу может менять только хост');

      const allowed = new Set<string>(TASK_FIELDS);
      for (const key of Object.keys(raw)) if (!allowed.has(key)) throw bad(`Нельзя менять поле: ${key}`);

      const patch: TaskPatch = {};
      if (raw.title !== undefined) patch.title = str(raw.title, 'title');
      if (raw.estimate_min !== undefined) patch.estimate_min = num(raw.estimate_min, 'estimate_min');
      if (raw.priority !== undefined) patch.priority = str(raw.priority, 'priority') as TaskPatch['priority'];
      if (raw.deadline !== undefined) patch.deadline = nullableStr(raw.deadline, 'deadline');
      if (raw.description !== undefined) patch.description = nullableStr(raw.description, 'description');
      if (raw.status !== undefined) {
        if (!isOwner) throw forbidden('Статус задачи меняет только её исполнитель');
        patch.status = str(raw.status, 'status') as TaskPatch['status'];
      }
      if (raw.assignee_id !== undefined && raw.assignee_id !== info.assignee_id) {
        if (!ctx.isHost) throw forbidden('Передавать задачи другим может только хост');
        const next = str(raw.assignee_id, 'assignee_id');
        if (info.status !== 'backlog') throw new CoworkError('Задачу в работе нельзя передать другому', 'CONFLICT');
        await requireActiveParticipant(next);
        patch.assignee_id = next;
      }
      return api.updateTask(id, patch);
    }

    case 'deleteTask': {
      const id = str(args[0], 'id');
      const info = await requireTask(id);
      if (!ctx.isHost && info.assignee_id !== ctx.callerId) throw forbidden('Чужую задачу может удалить только хост');
      if (info.status === 'in_progress' && (await api.getActiveSession(ctx.workspaceId, info.assignee_id))) {
        throw new CoworkError('Задачу нельзя удалить, пока она в плане активной сессии', 'CONFLICT');
      }
      return api.deleteTask(id);
    }

    case 'getActiveSession': {
      sameWorkspace(args[0]);
      if (str(args[1], 'userId') !== ctx.callerId) throw forbidden('Это чужая сессия');
      return api.getActiveSession(ctx.workspaceId, ctx.callerId);
    }

    case 'createSession': {
      sameWorkspace(args[0]);
      if (str(args[1], 'userId') !== ctx.callerId) throw forbidden('Нельзя начать сессию за другого участника');
      return api.createSession(ctx.workspaceId, ctx.callerId, num(args[2], 'windowMin'));
    }

    case 'deleteSession':
    case 'finishSession': {
      const id = str(args[0], 'id');
      await requireOwnSession(id);
      return method === 'deleteSession' ? api.deleteSession(id) : api.finishSession(id);
    }

    case 'getBlocks': {
      const id = str(args[0], 'sessionId');
      await requireOwnSession(id);
      return api.getBlocks(id);
    }

    case 'insertBlocks': {
      const sessionId = str(args[0], 'sessionId');
      await requireOwnSession(sessionId);
      if (!Array.isArray(args[1]) || args[1].length > 500) throw bad('Некорректный параметр: blocks');
      const blocks: NewBlock[] = [];
      for (const item of args[1]) {
        const b = record(item, 'block');
        const taskId = nullableStr(b.task_id, 'task_id');
        if (taskId !== null) {
          const info = await requireTask(taskId);
          if (info.assignee_id !== ctx.callerId) throw forbidden('В план можно добавлять только свои задачи');
        }
        const kind = str(b.kind, 'kind');
        if (kind !== 'work' && kind !== 'break') throw bad('Некорректный параметр: kind');
        blocks.push({
          task_id: taskId,
          position: num(b.position, 'position'),
          kind,
          planned_min: num(b.planned_min, 'planned_min'),
          started_at: str(b.started_at, 'started_at'),
        });
      }
      return api.insertBlocks(sessionId, blocks);
    }

    case 'setBlockMinutes': {
      const id = str(args[0], 'id');
      await requireOwnBlock(id);
      return api.setBlockMinutes(id, num(args[1], 'minutes'));
    }

    case 'deleteBlocks': {
      const ids = strList(args[0], 'ids');
      for (const id of ids) {
        const owner = await dataService.getBlockOwner(id);
        // Блок мог быть уже удалён: повторное удаление не ошибка
        if (owner !== null && owner !== ctx.callerId) throw forbidden('Это чужой блок');
      }
      return api.deleteBlocks(ids);
    }

    case 'completeBlock': {
      const id = str(args[0], 'id');
      await requireOwnBlock(id);
      return api.completeBlock(id);
    }

    default:
      throw bad(`Неизвестная команда: ${method}`);
  }
}
