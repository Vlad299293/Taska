'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Session, Status, Task } from '../lib/types';
import { PRIORITY_LABEL } from '../lib/types';
import { blockEndMs, formatClock, sortByUrgency } from '../lib/planner';
import type { TimedBlock } from '../lib/planner';
import Btn from './Btn';

const COLUMNS: { key: Status; title: string; empty: string }[] = [
  { key: 'backlog', title: 'Backlog', empty: 'Пока пусто. Добавьте задачу.' },
  { key: 'in_progress', title: 'В работе', empty: 'Перетащите сюда задачу или нажмите «Взять».' },
  { key: 'paused', title: 'Пауза', empty: 'Сюда попадают задачи, которые вы поставили на паузу.' },
  { key: 'done', title: 'Готово', empty: 'Здесь появятся завершённые задачи.' },
];

interface Props {
  tasks: Task[];
  session: Session | null;
  current: TimedBlock | undefined;
  nowMs: number;
  pending: string | null;
  onAdd: () => void;
  onEdit: (t: Task) => void;
  onTake: (t: Task) => void;
  onBack: (t: Task) => void;
  onDone: (t: Task) => void;
  onPause: (t: Task) => void;
  onDelete: (t: Task) => void;
  onMove: (id: string, to: Status) => void;
}

type Register = (id: string, el: HTMLElement | null) => void;

function TimerIcon() {
  return (
    <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' aria-hidden='true'>
      <circle cx='12' cy='14' r='7' />
      <path d='M12 14v-3M9 2h6M12 7V5' />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
      <path d='M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6' />
    </svg>
  );
}

function formatDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function Card({ task, p, register }: { task: Task; p: Props; register: Register }) {
  const [confirming, setConfirming] = useState(false);
  const active = !!p.current && p.current.kind === 'work' && p.current.taskId === task.id;
  const draggable = task.status === 'backlog' || task.status === 'paused' || task.status === 'in_progress';
  const remain =
    active && p.current ? Math.min(blockEndMs(p.current) - p.nowMs, p.current.minutes * 60000) / 1000 : 0;
  // Состояние кнопки: у нужной — крутилка, у остальных — блокировка, пока идёт действие
  const state = (action: string) => {
    const key = `${action}:${task.id}`;
    return { busy: p.pending === key, disabled: p.pending !== null && p.pending !== key };
  };

  // Удаление в два нажатия: первое спрашивает подтверждение, через 3 секунды сбрасывается
  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(id);
  }, [confirming]);

  return (
    <article
      ref={(el) => register(task.id, el)}
      className={`card s-${task.status} p-${task.priority}${active ? ' is-active' : ''}`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <h4>{task.title}</h4>
      <p className='meta'>
        {task.estimate_min} мин · <span className='prio'>{PRIORITY_LABEL[task.priority]}</span>
        {task.deadline ? ` · до ${formatDate(task.deadline)}` : ''}
      </p>
      {task.spent_min > 0 && task.status !== 'done' && (
        <p className='meta'>
          Сделано {task.spent_min} из {task.estimate_min} мин
        </p>
      )}
      {task.description && <p className='desc'>{task.description}</p>}
      {active && (
        <span className='chip'>
          <TimerIcon />
          <b>{formatClock(remain)}</b>
        </span>
      )}
      <div className='actions'>
        {(task.status === 'backlog' || task.status === 'paused') && (
          <Btn className='small' {...state('take')} onClick={() => p.onTake(task)}>
            Взять
          </Btn>
        )}
        {task.status === 'in_progress' && (
          <Btn className='small ghost' {...state('pause')} onClick={() => p.onPause(task)}>
            Пауза
          </Btn>
        )}
        {task.status === 'in_progress' && !p.session && (
          <Btn className='small ghost' {...state('back')} onClick={() => p.onBack(task)}>
            В Backlog
          </Btn>
        )}
        {task.status === 'in_progress' && p.session && (
          <Btn className='small' {...state('done')} onClick={() => p.onDone(task)}>
            Готово
          </Btn>
        )}
        <Btn className='small ghost' disabled={p.pending !== null} onClick={() => p.onEdit(task)}>
          Изменить
        </Btn>
        {task.status === 'done' && (
          <Btn
            className={confirming ? 'small danger' : 'small ghost icon'}
            aria-label='Удалить задачу'
            title='Удалить задачу'
            {...state('remove')}
            onClick={() => {
              if (confirming) {
                setConfirming(false);
                p.onDelete(task);
              } else {
                setConfirming(true);
              }
            }}
          >
            <TrashIcon />
            {confirming && <span>Удалить?</span>}
          </Btn>
        )}
      </div>
    </article>
  );
}

export default function Board(p: Props) {
  const boardRef = useRef<HTMLElement | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const spots = useRef(new Map<string, { x: number; y: number }>());
  const moving = useRef(new WeakSet<HTMLElement>());
  const [over, setOver] = useState<Status | null>(null);

  const register: Register = (id, el) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  };

  // Плавное перетекание карточек: сравниваем положение до и после обновления и анимируем разницу
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const base = board.getBoundingClientRect();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, { x: number; y: number }>();
    nodes.current.forEach((el, id) => {
      const prev = spots.current.get(id);
      if (moving.current.has(el) && prev) {
        next.set(id, prev);
        return;
      }
      const r = el.getBoundingClientRect();
      const spot = { x: r.left - base.left + board.scrollLeft, y: r.top - base.top };
      next.set(id, spot);
      if (!reduce && prev && (Math.abs(prev.x - spot.x) > 1 || Math.abs(prev.y - spot.y) > 1)) {
        moving.current.add(el);
        el.style.zIndex = '5';
        const anim = el.animate(
          [
            { transform: `translate(${prev.x - spot.x}px, ${prev.y - spot.y}px)` },
            { transform: 'translate(0px, 0px)' },
          ],
          { duration: 1000, easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)' },
        );
        anim.onfinish = () => {
          moving.current.delete(el);
          el.style.zIndex = '';
        };
      }
    });
    spots.current = next;
  });

  const ordered = (key: Status): Task[] => {
    const list = p.tasks.filter((t) => t.status === key);
    if (key === 'backlog' || key === 'paused') {
      return sortByUrgency(list.map((t) => ({ ...t, createdAt: t.created_at })));
    }
    return list;
  };

  return (
    <section ref={boardRef} className='board' aria-label='Доска задач'>
      {COLUMNS.map((col) => {
        const list = ordered(col.key);
        return (
          <div
            key={col.key}
            className={over === col.key ? 'col drag-over' : 'col'}
            onDragOver={(e) => {
              e.preventDefault();
              if (over !== col.key) setOver(col.key);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData('text/plain');
              if (id) p.onMove(id, col.key);
            }}
          >
            <h3>
              {col.title}
              <span className='n'>{list.length}</span>
            </h3>
            {col.key === 'backlog' && (
              <button className='add' onClick={p.onAdd}>
                + Задача
              </button>
            )}
            {list.length === 0 && <p className='empty'>{col.empty}</p>}
            {list.map((t) => (
              <Card key={t.id} task={t} p={p} register={register} />
            ))}
          </div>
        );
      })}
    </section>
  );
}
