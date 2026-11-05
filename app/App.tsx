'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dataService } from '../lib/data-service';
import { toPlanTask } from '../lib/types';
import type { Block, Session, Status, Summary, Task } from '../lib/types';
import type { UserProfile } from '../lib/auth-service';
import { blockEndMs, buildPlan, fitsWindow, locate, replan, schedule, sortByUrgency } from '../lib/planner';
import type { ReplanMode, TimedBlock } from '../lib/planner';
import { askPermission, beep, flashTitle, notify, unlockAudio } from '../lib/notify';
import { ErrorMapper } from '../lib/errors/error-mapper';
import Board from './Board';
import Focus from './Focus';
import TaskModal from './TaskModal';
import type { TaskInput } from './TaskModal';
import { Advice, SummaryModal } from './Parts';

const errorText = (e: unknown): string => ErrorMapper.map(e).message;

function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function signal(kind: 'work' | 'break' | 'end', title: string, body: string): void {
  beep(kind);
  notify(title, body);
  flashTitle(title);
}

export default function App({ user, onLogout }: { user: UserProfile; onLogout: () => void }) {
  const { id: userId, workspaceId } = user;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [windowMin, setWindowMin] = useState(180);
  const [modal, setModal] = useState<{ task: Task | null } | null>(null);
  const [adviceHidden, setAdviceHidden] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const nowMs = useNow();

  const load = useCallback(async () => {
    try {
      const [list, active] = await Promise.all([
        dataService.getTasks(workspaceId),
        dataService.getActiveSession(workspaceId, userId),
      ]);
      setTasks(list);
      setSession(active);
      setBlocks(active ? await dataService.getBlocks(active.id) : []);
      setLoaded(true);
    } catch (e) {
      setError(errorText(e));
      setLoaded(true);
    }
  }, [workspaceId, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const timed = useMemo<TimedBlock[]>(
    () =>
      blocks.map((b) => ({
        kind: b.kind,
        taskId: b.task_id,
        minutes: b.planned_min,
        startMs: new Date(b.started_at).getTime(),
      })),
    [blocks],
  );
  const pos = session ? locate(timed, nowMs) : null;
  const curIndex = pos ? (pos.state === 'running' ? pos.index : pos.state === 'before' ? 0 : -1) : -1;
  const current = curIndex >= 0 ? timed[curIndex] : undefined;

  const inWork = useMemo(() => tasks.filter((t) => t.status === 'in_progress'), [tasks]);
  const previewPlan = useMemo(() => buildPlan(inWork.map((t) => toPlanTask(t))), [inWork]);
  const windowValid = Number.isInteger(windowMin) && windowMin >= 30 && windowMin <= 720 && windowMin % 5 === 0;

  // key нужен, чтобы кнопка показала крутилку, пока действие выполняется
  const run = async (fn: () => Promise<void>, key: string) => {
    setError(null);
    setPending(key);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(null);
    }
  };

  const buildSummary = async (snapshot: Block[]) => {
    const ids = Array.from(new Set(snapshot.filter((b) => b.task_id).map((b) => b.task_id as string)));
    if (ids.length === 0) return;
    const list = await dataService.getTasksByIds(ids);
    setSummary({
      workMin: snapshot.filter((b) => b.kind === 'work').reduce((sum, b) => sum + b.planned_min, 0),
      done: list.filter((t) => t.status === 'done').map((t) => t.title),
      unfinished: list.filter((t) => t.status !== 'done').map((t) => t.title),
    });
  };

  // Учёт завершённых блоков и завершение сессии
  const syncing = useRef(false);
  const lastTry = useRef(0);
  useEffect(() => {
    if (!session || syncing.current || timed.length === 0) return;
    const overdue = blocks.filter((b, i) => b.kind === 'work' && !b.ended_at && blockEndMs(timed[i]) <= nowMs);
    const over = nowMs >= blockEndMs(timed[timed.length - 1]);
    if (overdue.length === 0 && !over) return;
    if (Date.now() - lastTry.current < 3000) return;
    lastTry.current = Date.now();
    syncing.current = true;
    const snapshot = blocks;
    (async () => {
      for (const b of overdue) await dataService.completeBlock(b.id);
      if (over) {
        await dataService.finishSession(session.id);
        await buildSummary(snapshot);
        setAdviceHidden(false);
        signal('end', 'Сессия завершена', 'Откройте итоги');
      }
      await load();
    })()
      .catch((e) => setError(errorText(e)))
      .finally(() => {
        syncing.current = false;
      });
  }, [nowMs, session, blocks, timed, load]);

  // Сигналы при смене блока и перерыва
  const prevIndex = useRef<number | null>(null);
  useEffect(() => {
    if (!session) {
      prevIndex.current = null;
      return;
    }
    if (curIndex < 0) return;
    const prev = prevIndex.current;
    prevIndex.current = curIndex;
    if (prev === null || prev === curIndex) return;
    const b = blocks[curIndex];
    if (!b) return;
    if (b.kind === 'break') signal('break', 'Перерыв 5 минут', 'Встаньте, посмотрите вдаль');
    else signal('work', 'Начался новый блок', tasks.find((t) => t.id === b.task_id)?.title ?? '');
  }, [session, curIndex, blocks, tasks]);

  // Пересчёт плана на оставшееся время (состав «В работе» изменился, задача завершена досрочно или поставлена на паузу)
  const doReplan = async (tasksNow: Task[], mode: ReplanMode) => {
    if (!session || curIndex < 0) {
      await load();
      return;
    }
    const remaining = tasksNow.filter((t) => t.status === 'in_progress').map((t) => toPlanTask(t, current));
    const { keep, added } = replan(timed, Date.now(), remaining, mode);
    const last = keep.length - 1;
    if (last >= 0 && keep[last].minutes !== blocks[last].planned_min) {
      await dataService.setBlockMinutes(blocks[last].id, keep[last].minutes);
    }
    await dataService.deleteBlocks(blocks.slice(keep.length).map((b) => b.id));
    await dataService.insertBlocks(
      session.id,
      added.map((b, i) => ({
        task_id: b.taskId,
        position: keep.length + i,
        kind: b.kind,
        planned_min: b.minutes,
        started_at: new Date(b.startMs).toISOString(),
      })),
    );
    // Блоков больше не осталось: сессию нужно завершить сразу
    if (keep.length + added.length === 0) await dataService.finishSession(session.id);
    await load();
  };

  const startSession = () =>
    run(async () => {
      if (previewPlan.length === 0 || !windowValid || !fitsWindow(previewPlan, windowMin)) return;
      unlockAudio();
      void askPermission();
      const s = await dataService.createSession(workspaceId, userId, windowMin);
      const rows = schedule(previewPlan, new Date(s.started_at).getTime()).map((b, i) => ({
        task_id: b.taskId,
        position: i,
        kind: b.kind,
        planned_min: b.minutes,
        started_at: new Date(b.startMs).toISOString(),
      }));
      try {
        await dataService.insertBlocks(s.id, rows);
      } catch (e) {
        // Сессия без блоков бесполезна и мешает начать новую (активная сессия может быть только одна)
        await dataService.deleteSession(s.id);
        throw e;
      }
      setSummary(null);
      await load();
    }, 'start');

  const takeTask = (task: Task) =>
    run(async () => {
      await dataService.updateTask(task.id, { status: 'in_progress' });
      const after = tasks.map((t) => (t.id === task.id ? { ...t, status: 'in_progress' as Status } : t));
      await doReplan(after, 'none');
    }, `take:${task.id}`);

  const backToBacklog = (task: Task) =>
    run(async () => {
      if (session) return;
      await dataService.updateTask(task.id, { status: 'backlog' });
      await load();
    }, `back:${task.id}`);

  // Пауза задачи (не таймера): если задача активна, её время засчитывается, а следующая стартует сразу
  const pauseTask = (task: Task) =>
    run(async () => {
      await dataService.updateTask(task.id, { status: 'paused' });
      const after = tasks.map((t) => (t.id === task.id ? { ...t, status: 'paused' as Status } : t));
      const activeNow = !!current && current.kind === 'work' && current.taskId === task.id;
      await doReplan(after, activeNow ? 'handover' : 'none');
    }, `pause:${task.id}`);

  const markDone = (task: Task) =>
    run(async () => {
      await dataService.updateTask(task.id, { status: 'done' });
      const after = tasks.map((t) => (t.id === task.id ? { ...t, status: 'done' as Status } : t));
      const activeNow = !!current && current.kind === 'work' && current.taskId === task.id;
      await doReplan(after, activeNow ? 'cut' : 'none');
    }, `done:${task.id}`);

  const removeTask = (task: Task) =>
    run(async () => {
      await dataService.deleteTask(task.id);
      await load();
    }, `remove:${task.id}`);

  const moveTask = (id: string, to: Status) => {
    if (pending !== null) return;
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status === to) return;
    if (to === 'in_progress' && (t.status === 'backlog' || t.status === 'paused')) void takeTask(t);
    else if (to === 'paused' && t.status === 'in_progress') void pauseTask(t);
    else if (to === 'backlog' && t.status === 'in_progress' && !session) void backToBacklog(t);
  };

  const saveTask = (input: TaskInput) =>
    run(async () => {
      const editing = modal?.task ?? null;
      if (editing) {
        await dataService.updateTask(editing.id, input);
        const after = tasks.map((t) => (t.id === editing.id ? { ...t, ...input } : t));
        if (editing.status === 'in_progress') await doReplan(after, 'none');
        else await load();
      } else {
        await dataService.createTask(workspaceId, input);
        await load();
      }
      setModal(null);
    }, 'save');

  const deleteTask = () =>
    run(async () => {
      const editing = modal?.task ?? null;
      if (!editing) return;
      await dataService.deleteTask(editing.id);
      await load();
      setModal(null);
    }, 'delete');

  // Совет взять вторую задачу, если в работе одна большая
  const others = useMemo(
    () =>
      sortByUrgency(
        tasks.filter((t) => t.status === 'backlog' || t.status === 'paused').map((t) => ({ ...t, createdAt: t.created_at })),
      ),
    [tasks],
  );
  const showAdvice = !adviceHidden && inWork.length === 1 && inWork[0].estimate_min > 30 && others.length > 0;

  const editingTask = modal?.task ?? null;
  const canDelete = !!editingTask && !(session && editingTask.status === 'in_progress');

  if (!loaded && !error) {
    return (
      <div className='app'>
        <p className='muted loading'>
          <span className='spin' aria-hidden='true' /> Загрузка…
        </p>
      </div>
    );
  }

  return (
    <div className='app'>
      {pending !== null && <div className='progress' aria-hidden='true' />}
      <header className='top'>
        <div className='brand'>Taska</div>
        <div className='top-r'>
          <span className='email'>{user.nickname}</span>
          <button className='link' onClick={onLogout}>
            Выйти
          </button>
        </div>
      </header>
      {error && (
        <p className='error' role='alert'>
          {error}
        </p>
      )}
      <Focus
        session={session}
        timed={timed}
        curIndex={curIndex}
        nowMs={nowMs}
        tasks={tasks}
        inWork={inWork}
        previewPlan={previewPlan}
        windowMin={windowMin}
        windowValid={windowValid}
        pending={pending}
        onWindow={setWindowMin}
        onStart={() => void startSession()}
        onRemove={(t) => void backToBacklog(t)}
      />
      {showAdvice && (
        <Advice
          suggestions={others.slice(0, 3)}
          pending={pending}
          onTake={(t) => void takeTask(t)}
          onDismiss={() => setAdviceHidden(true)}
        />
      )}
      <Board
        tasks={tasks}
        session={session}
        current={current}
        nowMs={nowMs}
        pending={pending}
        onAdd={() => setModal({ task: null })}
        onEdit={(t) => setModal({ task: t })}
        onTake={(t) => void takeTask(t)}
        onBack={(t) => void backToBacklog(t)}
        onDone={(t) => void markDone(t)}
        onPause={(t) => void pauseTask(t)}
        onDelete={(t) => void removeTask(t)}
        onMove={moveTask}
      />
      {modal && (
        <TaskModal
          task={editingTask}
          canDelete={canDelete}
          pending={pending}
          onSave={(input) => void saveTask(input)}
          onDelete={() => void deleteTask()}
          onClose={() => setModal(null)}
        />
      )}
      {summary && <SummaryModal summary={summary} onClose={() => setSummary(null)} />}
    </div>
  );
}
