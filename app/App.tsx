'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LiveApi } from '../lib/data-api';
import { toPlanTask } from '../lib/types';
import type { Block, Participant, Session, Status, Summary, Task } from '../lib/types';
import { blockEndMs, buildPlan, fitsWindow, locate, replan, schedule, sortByUrgency } from '../lib/planner';
import type { ReplanMode, TimedBlock } from '../lib/planner';
import { askPermission, beep, flashTitle, notify, unlockAudio } from '../lib/notify';
import { ErrorMapper } from '../lib/errors/error-mapper';
import Board from './Board';
import Focus from './Focus';
import TaskModal from './TaskModal';
import type { TaskInput } from './TaskModal';
import { Advice, SummaryModal } from './Parts';
import { PeopleBar } from './PersonChip';

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

export interface AppUser {
  id: string;
  workspaceId: string;
  nickname: string;
}

interface AppProps {
  user: AppUser;
  /** Откуда берутся данные: локальная база (обычный режим, хост) или хост по сети (гость) */
  api: LiveApi;
  /** Режим cowork: видны задачи всех участников */
  cowork: boolean;
  isHost: boolean;
  headerSlot?: ReactNode;
  onLogout: () => void;
}

export default function App({ user, api, cowork, isHost, headerSlot, onLogout }: AppProps) {
  const { id: userId, workspaceId } = user;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [people, setPeople] = useState<Participant[]>([]);
  const [filter, setFilter] = useState<string>('all');
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
      const [list, active, participants] = await Promise.all([
        api.getTasks(workspaceId),
        api.getActiveSession(workspaceId, userId),
        api.getParticipants(workspaceId),
      ]);
      setTasks(list);
      setPeople(participants);
      setSession(active);
      setBlocks(active ? await api.getBlocks(active.id) : []);
      setError(null);
      setLoaded(true);
    } catch (e) {
      setError(errorText(e));
      setLoaded(true);
    }
  }, [api, workspaceId, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Изменения от других участников (и свои с другого окна) приходят сюда и обновляют список
  useEffect(() => api.subscribe(() => void load()), [api, load]);

  // Планировать и работать можно только со своими задачами; чужие видны на доске, но не попадают в план
  const mine = useMemo(() => tasks.filter((t) => t.assignee_id === userId), [tasks, userId]);
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const visible = useMemo(() => {
    if (!cowork) return mine;
    return filter === 'all' ? tasks : tasks.filter((t) => t.assignee_id === filter);
  }, [cowork, tasks, mine, filter]);
  // Если выбранный участник пропал из списка, возвращаемся к «Все»
  useEffect(() => {
    if (filter !== 'all' && !people.some((p) => p.id === filter)) setFilter('all');
  }, [people, filter]);

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

  const inWork = useMemo(() => mine.filter((t) => t.status === 'in_progress'), [mine]);
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
    const list = await api.getTasksByIds(ids);
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
      for (const b of overdue) await api.completeBlock(b.id);
      if (over) {
        await api.finishSession(session.id);
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
    const remaining = tasksNow.filter((t) => t.status === 'in_progress' && t.assignee_id === userId).map((t) => toPlanTask(t, current));
    const { keep, added } = replan(timed, Date.now(), remaining, mode);
    const last = keep.length - 1;
    if (last >= 0 && keep[last].minutes !== blocks[last].planned_min) {
      await api.setBlockMinutes(blocks[last].id, keep[last].minutes);
    }
    await api.deleteBlocks(blocks.slice(keep.length).map((b) => b.id));
    await api.insertBlocks(
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
    if (keep.length + added.length === 0) await api.finishSession(session.id);
    await load();
  };

  const startSession = () =>
    run(async () => {
      if (previewPlan.length === 0 || !windowValid || !fitsWindow(previewPlan, windowMin)) return;
      unlockAudio();
      void askPermission();
      const s = await api.createSession(workspaceId, userId, windowMin);
      const rows = schedule(previewPlan, new Date(s.started_at).getTime()).map((b, i) => ({
        task_id: b.taskId,
        position: i,
        kind: b.kind,
        planned_min: b.minutes,
        started_at: new Date(b.startMs).toISOString(),
      }));
      try {
        await api.insertBlocks(s.id, rows);
      } catch (e) {
        // Сессия без блоков бесполезна и мешает начать новую (активная сессия может быть только одна)
        await api.deleteSession(s.id);
        throw e;
      }
      setSummary(null);
      await load();
    }, 'start');

  const takeTask = (task: Task) =>
    run(async () => {
      await api.updateTask(task.id, { status: 'in_progress' });
      const after = tasks.map((t) => (t.id === task.id ? { ...t, status: 'in_progress' as Status } : t));
      await doReplan(after, 'none');
    }, `take:${task.id}`);

  const backToBacklog = (task: Task) =>
    run(async () => {
      if (session) return;
      await api.updateTask(task.id, { status: 'backlog' });
      await load();
    }, `back:${task.id}`);

  // Пауза задачи (не таймера): если задача активна, её время засчитывается, а следующая стартует сразу
  const pauseTask = (task: Task) =>
    run(async () => {
      await api.updateTask(task.id, { status: 'paused' });
      const after = tasks.map((t) => (t.id === task.id ? { ...t, status: 'paused' as Status } : t));
      const activeNow = !!current && current.kind === 'work' && current.taskId === task.id;
      await doReplan(after, activeNow ? 'handover' : 'none');
    }, `pause:${task.id}`);

  const markDone = (task: Task) =>
    run(async () => {
      await api.updateTask(task.id, { status: 'done' });
      const after = tasks.map((t) => (t.id === task.id ? { ...t, status: 'done' as Status } : t));
      const activeNow = !!current && current.kind === 'work' && current.taskId === task.id;
      await doReplan(after, activeNow ? 'cut' : 'none');
    }, `done:${task.id}`);

  const removeTask = (task: Task) =>
    run(async () => {
      await api.deleteTask(task.id);
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
        await api.updateTask(editing.id, input);
        const after = tasks.map((t) => (t.id === editing.id ? { ...t, ...input } : t));
        if (editing.status === 'in_progress' && editing.assignee_id === userId) await doReplan(after, 'none');
        else await load();
      } else {
        await api.createTask(workspaceId, input);
        await load();
      }
      setModal(null);
    }, 'save');

  const deleteTask = () =>
    run(async () => {
      const editing = modal?.task ?? null;
      if (!editing) return;
      await api.deleteTask(editing.id);
      await load();
      setModal(null);
    }, 'delete');

  // Совет взять вторую задачу, если в работе одна большая
  const others = useMemo(
    () =>
      sortByUrgency(
        mine.filter((t) => t.status === 'backlog' || t.status === 'paused').map((t) => ({ ...t, createdAt: t.created_at })),
      ),
    [mine],
  );
  const showAdvice = !adviceHidden && inWork.length === 1 && inWork[0].estimate_min > 30 && others.length > 0;

  const editingTask = modal?.task ?? null;
  // Свою задачу нельзя удалить, пока она в плане сессии. Хост может удалять чужие, но не те, что в работе: у владельца может идти сессия
  const canManage = (t: Task) => t.assignee_id === userId || isHost;
  const canDelete =
    !!editingTask &&
    canManage(editingTask) &&
    (editingTask.assignee_id === userId ? !(session && editingTask.status === 'in_progress') : editingTask.status !== 'in_progress');
  // Участники, которым можно поставить задачу
  const assignable = people.filter((p) => p.active);

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
        {headerSlot}
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
        tasks={mine}
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
      {cowork && <PeopleBar people={people} tasks={tasks} meId={userId} selected={filter} onSelect={setFilter} />}
      <Board
        tasks={visible}
        meId={userId}
        isHost={isHost}
        people={peopleById}
        showOwner={cowork}
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
          meId={userId}
          people={assignable}
          canAssign={cowork && isHost}
          defaultAssignee={filter !== 'all' && assignable.some((p) => p.id === filter) ? filter : userId}
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
