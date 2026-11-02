'use client';

import type { Session, Task } from '../lib/types';
import { toPlanTask } from '../lib/types';
import { blockEndMs, buildPlan, formatClock, formatDuration, planMinutes } from '../lib/planner';
import type { PlanBlock, TimedBlock } from '../lib/planner';
import Btn from './Btn';

interface Props {
  session: Session | null;
  timed: TimedBlock[];
  curIndex: number;
  nowMs: number;
  tasks: Task[];
  inWork: Task[];
  previewPlan: PlanBlock[];
  windowMin: number;
  windowValid: boolean;
  pending: string | null;
  onWindow: (minutes: number) => void;
  onStart: () => void;
  onRemove: (task: Task) => void;
}

const PRESETS = [60, 120, 180, 240];

export default function Focus(props: Props) {
  if (props.session && props.curIndex >= 0) {
    return (
      <Running
        session={props.session}
        timed={props.timed}
        curIndex={props.curIndex}
        nowMs={props.nowMs}
        tasks={props.tasks}
      />
    );
  }
  return <Setup {...props} />;
}

function Running({
  session,
  timed,
  curIndex,
  nowMs,
  tasks,
}: {
  session: Session;
  timed: TimedBlock[];
  curIndex: number;
  nowMs: number;
  tasks: Task[];
}) {
  const cur = timed[curIndex];
  const isBreak = cur.kind === 'break';
  const title = (id: string | null) => tasks.find((t) => t.id === id)?.title ?? '';
  const remainMs = Math.min(blockEndMs(cur) - nowMs, cur.minutes * 60000);
  const workIdx: number[] = [];
  timed.forEach((b, i) => {
    if (b.kind === 'work') workIdx.push(i);
  });
  const mine = workIdx.filter((i) => timed[i].taskId === cur.taskId);
  const ordinal = mine.filter((i) => i <= curIndex).length;
  const next = timed.findIndex((b, i) => i > curIndex && b.kind === 'work');
  const windowLeft = Math.max(
    0,
    Math.ceil((new Date(session.started_at).getTime() + session.window_min * 60000 - nowMs) / 60000),
  );

  return (
    <section className={isBreak ? 'focus is-break' : 'focus'}>
      <p className='state'>
        {isBreak ? 'Перерыв' : `Блок ${ordinal} из ${mine.length}`} · в окне осталось {formatDuration(windowLeft)}
      </p>
      <div className='big' role='timer'>
        {formatClock(remainMs / 1000)}
      </div>
      <p className='task'>{isBreak ? 'Встаньте, посмотрите вдаль' : title(cur.taskId)}</p>
      <div className='dots' aria-label='Блоки плана'>
        {workIdx.map((i) => (
          <i key={i} className={i < curIndex ? 'dot done' : i === curIndex ? 'dot cur' : 'dot'} />
        ))}
      </div>
      <p className='next'>
        {next >= 0 ? `Дальше: ${title(timed[next].taskId)}` : isBreak ? '' : 'Это последний блок'}
      </p>
    </section>
  );
}

function Setup({ inWork, previewPlan, windowMin, windowValid, pending, onWindow, onStart, onRemove }: Props) {
  const total = planMinutes(previewPlan);
  const blocksCount = previewPlan.filter((b) => b.kind === 'work').length;
  const breaksCount = previewPlan.length - blocksCount;
  const tooLong = windowValid && total > windowMin;
  const canStart = windowValid && previewPlan.length > 0 && !tooLong;

  return (
    <section className='focus setup'>
      <h2>Новая сессия</h2>
      <label className='field'>
        <span>Сколько времени у вас есть, минут</span>
        <input
          type='number'
          min={30}
          max={720}
          step={5}
          value={Number.isFinite(windowMin) ? windowMin : ''}
          onChange={(e) => onWindow(e.target.value === '' ? NaN : Number(e.target.value))}
        />
      </label>
      <div className='presets'>
        {PRESETS.map((m) => (
          <button key={m} className={windowMin === m ? 'preset on' : 'preset'} onClick={() => onWindow(m)}>
            {formatDuration(m)}
          </button>
        ))}
      </div>
      {!windowValid && <p className='muted'>Окно от 30 до 720 минут, шаг 5.</p>}
      {windowValid && inWork.length === 0 && (
        <p className='muted'>Возьмите задачи в работу, и я построю план.</p>
      )}
      {windowValid && inWork.length > 0 && !tooLong && (
        <p className='plan-line'>
          Блоков: {blocksCount}, перерывов: {breaksCount}. Всего {formatDuration(total)} из {formatDuration(windowMin)}.
        </p>
      )}
      {tooLong && (
        <div className='shortage' role='alert'>
          <p>
            <b>План не помещается:</b> нужно {formatDuration(total)}, а в окне {formatDuration(windowMin)}. Уберите
            задачи обратно в Backlog.
          </p>
          {inWork.map((t) => {
            const without = planMinutes(
              buildPlan(inWork.filter((x) => x.id !== t.id).map((x) => toPlanTask(x))),
            );
            const key = `back:${t.id}`;
            return (
              <div className='shortage-row' key={t.id}>
                <span>{t.title}</span>
                <Btn
                  className='small'
                  busy={pending === key}
                  disabled={pending !== null && pending !== key}
                  onClick={() => onRemove(t)}
                >
                  Убрать · останется {formatDuration(without)}
                </Btn>
              </div>
            );
          })}
        </div>
      )}
      <Btn
        className='primary wide'
        busy={pending === 'start'}
        disabled={!canStart || (pending !== null && pending !== 'start')}
        onClick={onStart}
      >
        Старт
      </Btn>
    </section>
  );
}
