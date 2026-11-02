'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { toPlanTask } from '../lib/types';
import type { Block, Session, Status, Summary, Task } from '../lib/types';
import { blockEndMs, buildPlan, fitsWindow, locate, replan, schedule, sortByUrgency } from '../lib/planner';
import type { ReplanMode, TimedBlock } from '../lib/planner';
import { askPermission, beep, flashTitle, notify, unlockAudio } from '../lib/notify';
import Board from './Board';
import Focus from './Focus';
import TaskModal from './TaskModal';
import type { TaskInput } from './TaskModal';
import { Advice, SummaryModal } from './Parts';

function check(res: { error: { message: string } | null }): void {
  if (res.error) throw new Error(res.error.message);
}

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

export default function App({ userId, email }: { userId: string; email: string }) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [nickname, setNickname] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [windowMin, setWindowMin] = useState(180);
  const [modal, setModal] = useState<{ task: Task | null } | null>(null);
  const [adviceHidden, setAdviceHidden] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const nowMs = useNow();

  // Рабочее пространство пользователя создаётся в базе при регистрации
  useEffect(() => {
    (async () => {
      const res = await supabase.from('workspace_members').select('workspace_id').eq('user_id', userId).limit(1);
      if (res.error) return setError(res.error.message);
      if (!res.data || res.data.length === 0) {
        return setError('Не найдено рабочее пространство. Выйдите и войдите снова.');
      }
      setWorkspaceId(res.data[0].workspace_id as string);
    })();
  }, [userId]);

  useEffect(() => {
    supabase
      .from('profiles')
      .select('nickname')
      .eq('user_id', userId)
      .maybeSingle()
      .then((res) => {
        const row = res.data as { nickname: string } | null;
        if (row) setNickname(row.nickname);
      });
  }, [userId]);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    const [t, s] = await Promise.all([
      supabase.from('tasks').select('*').eq('workspace_id', workspaceId).order('created_at'),
      supabase
        .from('sessions')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .is('ended_at', null)
        .maybeSingle(),
    ]);
    if (t.error) return setError(t.error.message);
    if (s.error) return setError(s.error.message);
    setTasks((t.data ?? []) as Task[]);
    const active = (s.data ?? null) as Session | null;
    setSession(active);
    if (active) {
      const b = await supabase.from('session_blocks').select('*').eq('session_id', active.id).order('position');
      if (b.error) return setError(b.error.message);
      setBlocks((b.data ?? []) as Block[]);
    } else {
      setBlocks([]);
    }
    setLoaded(true);
  }, [workspaceId, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Синхронизация между устройствами
  useEffect(() => {
    if (!workspaceId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 250);
    };
    const channel = supabase
      .channel('planner-' + workspaceId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'session_blocks' }, refresh)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [workspaceId, load]);

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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const buildSummary = async (snapshot: Block[]) => {
    const ids = Array.from(new Set(snapshot.filter((b) => b.task_id).map((b) => b.task_id as string)));
    if (ids.length === 0) return;
    const res = await supabase.from('tasks').select('*').in('id', ids);
    const list = (res.data ?? []) as Task[];
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
      for (const b of overdue) await supabase.rpc('complete_block', { p_block_id: b.id });
      if (over) {
        await supabase.rpc('finish_session', { p_session_id: session.id });
        await buildSummary(snapshot);
        setAdviceHidden(false);
        signal('end', 'Сессия завершена', 'Откройте итоги');
      }
      await load();
    })()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
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
      check(
        await supabase.from('session_blocks').update({ planned_min: keep[last].minutes }).eq('id', blocks[last].id),
      );
    }
    const future = blocks.slice(keep.length).map((b) => b.id);
    if (future.length > 0) check(await supabase.from('session_blocks').delete().in('id', future));
    if (added.length > 0) {
      check(
        await supabase.from('session_blocks').insert(
          added.map((b, i) => ({
            session_id: session.id,
            task_id: b.taskId,
            position: keep.length + i,
            kind: b.kind,
            planned_min: b.minutes,
            started_at: new Date(b.startMs).toISOString(),
          })),
        ),
      );
    }
    // Блоков больше не осталось: сессию нужно завершить сразу
    if (keep.length + added.length === 0) check(await supabase.rpc('finish_session', { p_session_id: session.id }));
    await load();
  };

  const startSession = () =>
    run(async () => {
      if (!workspaceId || previewPlan.length === 0 || !windowValid || !fitsWindow(previewPlan, windowMin)) return;
      unlockAudio();
      void askPermission();
      const created = await supabase
        .from('sessions')
        .insert({ workspace_id: workspaceId, user_id: userId, window_min: windowMin })
        .select()
        .single();
      check(created);
      const s = created.data as Session;
      const rows = schedule(previewPlan, new Date(s.started_at).getTime()).map((b, i) => ({
        session_id: s.id,
        task_id: b.taskId,
        position: i,
        kind: b.kind,
        planned_min: b.minutes,
        started_at: new Date(b.startMs).toISOString(),
      }));
      const inserted = await supabase.from('session_blocks').insert(rows);
      if (inserted.error) {
        await supabase.from('sessions').delete().eq('id', s.id);
        throw new Error(inserted.error.message);
      }
      setSummary(null);
      await load();
    }, 'start');

  const takeTask = (task: Task) =>
    run(async () => {
      check(await supabase.from('tasks').update({ status: 'in_progress' }).eq('id', task.id));
      const after = tasks.map((t) => (t.id === task.id ? { ...t, status: 'in_progress' as Status } : t));
      await doReplan(after, 'none');
    }, `take:${task.id}`);

  const backToBacklog = (task: Task) =>
    run(async () => {
      if (session) return;
      check(await supabase.from('tasks').update({ status: 'backlog' }).eq('id', task.id));
      await load();
    }, `back:${task.id}`);

  // Пауза задачи (не таймера): если задача активна, её время засчитывается, а следующая стартует сразу
  const pauseTask = (task: Task) =>
    run(async () => {
      check(await supabase.from('tasks').update({ status: 'paused' }).eq('id', task.id));
      const after = tasks.map((t) => (t.id === task.id ? { ...t, status: 'paused' as Status } : t));
      const activeNow = !!current && current.kind === 'work' && current.taskId === task.id;
      await doReplan(after, activeNow ? 'handover' : 'none');
    }, `pause:${task.id}`);

  const markDone = (task: Task) =>
    run(async () => {
      check(await supabase.from('tasks').update({ status: 'done' }).eq('id', task.id));
      const after = tasks.map((t) => (t.id === task.id ? { ...t, status: 'done' as Status } : t));
      const activeNow = !!current && current.kind === 'work' && current.taskId === task.id;
      await doReplan(after, activeNow ? 'cut' : 'none');
    }, `done:${task.id}`);

  const removeTask = (task: Task) =>
    run(async () => {
      check(await supabase.from('tasks').delete().eq('id', task.id));
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
      if (!workspaceId) return;
      const editing = modal?.task ?? null;
      if (editing) {
        check(await supabase.from('tasks').update(input).eq('id', editing.id));
        const after = tasks.map((t) => (t.id === editing.id ? { ...t, ...input } : t));
        if (editing.status === 'in_progress') await doReplan(after, 'none');
        else await load();
      } else {
        check(await supabase.from('tasks').insert({ ...input, workspace_id: workspaceId }));
        await load();
      }
      setModal(null);
    }, 'save');

  const deleteTask = () =>
    run(async () => {
      const editing = modal?.task ?? null;
      if (!editing) return;
      check(await supabase.from('tasks').delete().eq('id', editing.id));
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
          <span className='email'>{nickname || email}</span>
          <button
            className='link'
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true);
              void supabase.auth.signOut();
            }}
          >
            {signingOut ? 'Выходим…' : 'Выйти'}
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
