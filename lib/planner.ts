export type Priority = 'high' | 'medium' | 'low';

export const BLOCK_MIN = 30;
export const BREAK_MIN = 5;

export interface PlanTask {
  id: string;
  priority: Priority;
  deadline: string | null;
  createdAt: string;
  remaining: number;
}

export interface PlanBlock {
  kind: 'work' | 'break';
  taskId: string | null;
  minutes: number;
}

export interface TimedBlock extends PlanBlock {
  startMs: number;
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

function compareDeadline(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** Срочность: приоритет, затем ближайший дедлайн (без дедлайна позже), затем дата создания. */
export function sortByUrgency<T extends { priority: Priority; deadline: string | null; createdAt: string }>(
  tasks: T[],
): T[] {
  return [...tasks].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      compareDeadline(a.deadline, b.deadline) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

/** Делит остаток на блоки по 30 минут; последний блок короче, если остаток не кратен 30. */
export function splitIntoBlocks(minutes: number): number[] {
  const out: number[] = [];
  let rest = minutes;
  while (rest > 0) {
    out.push(Math.min(BLOCK_MIN, rest));
    rest -= BLOCK_MIN;
  }
  return out;
}

/** Расставляет перерывы между соседними блоками; после последнего блока перерыва нет. */
export function withBreaks(work: PlanBlock[]): PlanBlock[] {
  const out: PlanBlock[] = [];
  work.forEach((block, i) => {
    if (i > 0) out.push({ kind: 'break', taskId: null, minutes: BREAK_MIN });
    out.push(block);
  });
  return out;
}

/** Блоки выдаются по кругу в порядке срочности: в каждом круге каждая задача с остатком получает один блок. */
export function buildPlan(tasks: PlanTask[]): PlanBlock[] {
  const queues = sortByUrgency(tasks)
    .filter((t) => t.remaining > 0)
    .map((t) => ({ id: t.id, blocks: splitIntoBlocks(t.remaining) }));
  const work: PlanBlock[] = [];
  for (let round = 0; queues.some((q) => q.blocks.length > round); round++) {
    for (const q of queues) {
      if (q.blocks.length > round) work.push({ kind: 'work', taskId: q.id, minutes: q.blocks[round] });
    }
  }
  return withBreaks(work);
}

export function planMinutes(plan: PlanBlock[]): number {
  return plan.reduce((sum, b) => sum + b.minutes, 0);
}

export function fitsWindow(plan: PlanBlock[], windowMin: number): boolean {
  return planMinutes(plan) <= windowMin;
}

/** Привязывает блоки ко времени: каждый следующий начинается сразу после предыдущего. */
export function schedule(plan: PlanBlock[], startMs: number): TimedBlock[] {
  let t = startMs;
  return plan.map((b) => {
    const timed = { ...b, startMs: t };
    t += b.minutes * 60000;
    return timed;
  });
}

export function blockEndMs(b: TimedBlock): number {
  return b.startMs + b.minutes * 60000;
}

export type Position =
  | { state: 'before' }
  | { state: 'running'; index: number }
  | { state: 'finished' };

export function locate(blocks: TimedBlock[], nowMs: number): Position {
  if (blocks.length === 0) return { state: 'finished' };
  if (nowMs < blocks[0].startMs) return { state: 'before' };
  for (let i = 0; i < blocks.length; i++) {
    if (nowMs >= blocks[i].startMs && nowMs < blockEndMs(blocks[i])) return { state: 'running', index: i };
  }
  return { state: 'finished' };
}

/** Сколько минут задаче осталось выполнить, не считая блока, который идёт сейчас. */
export function remainingFor(
  task: { id: string; estimate_min: number; spent_min: number },
  current: TimedBlock | undefined,
): number {
  const inflight = current && current.kind === 'work' && current.taskId === task.id ? current.minutes : 0;
  return Math.max(0, task.estimate_min - task.spent_min - inflight);
}

export type ReplanMode = 'none' | 'cut' | 'handover';

/**
 * Пересчёт плана на оставшееся время. Оставляет блоки до текущего включительно,
 * остальное строит заново.
 * - none: текущий блок доходит до конца, затем перерыв и новые блоки;
 * - cut: текущий блок обрезается по текущему моменту (задача завершена досрочно), затем перерыв;
 * - handover: задача ушла в паузу посреди блока. Засчитываются только полные отработанные минуты
 *   (если их нет, блок удаляется целиком), следующая задача стартует сразу, без перерыва.
 */
export function replan(
  blocks: TimedBlock[],
  nowMs: number,
  remaining: PlanTask[],
  mode: ReplanMode | boolean = 'none',
): { keep: TimedBlock[]; added: TimedBlock[] } {
  const m: ReplanMode = mode === true ? 'cut' : mode === false ? 'none' : mode;
  const keep = blocks.filter((b) => b.startMs <= nowMs).map((b) => ({ ...b }));
  const cur = keep[keep.length - 1];
  if (!cur) return { keep: [], added: schedule(buildPlan(remaining), nowMs) };
  if (m === 'handover' && cur.kind === 'work') {
    const worked = Math.floor((nowMs - cur.startMs) / 60000);
    if (worked <= 0) keep.pop();
    else cur.minutes = Math.min(cur.minutes, worked);
    return { keep, added: schedule(buildPlan(remaining), nowMs) };
  }
  if (m === 'cut') {
    const elapsed = Math.round((nowMs - cur.startMs) / 60000);
    cur.minutes = Math.min(cur.minutes, Math.max(1, elapsed));
  }
  let plan = buildPlan(remaining);
  if (cur.kind === 'work' && plan.length > 0) plan = [{ kind: 'break', taskId: null, minutes: BREAK_MIN }, ...plan];
  return { keep, added: schedule(plan, blockEndMs(cur)) };
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}
