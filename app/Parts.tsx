'use client';

import type { Summary, Task } from '../lib/types';
import { formatDuration } from '../lib/planner';
import Btn from './Btn';

export function Advice({
  suggestions,
  pending,
  onTake,
  onDismiss,
}: {
  suggestions: Task[];
  pending: string | null;
  onTake: (t: Task) => void;
  onDismiss: () => void;
}) {
  return (
    <aside className='advice' role='alert'>
      <div>
        <b>Одна большая задача на несколько часов утомляет</b>
        <p>Возьмите вторую: полчаса на одну, полчаса на другую. Так проще сохранить силы.</p>
      </div>
      <div className='acts'>
        {suggestions.map((t) => {
          const key = `take:${t.id}`;
          return (
            <Btn key={t.id} busy={pending === key} disabled={pending !== null && pending !== key} onClick={() => onTake(t)}>
              Взять «{t.title}»
            </Btn>
          );
        })}
        <Btn className='ghost' disabled={pending !== null} onClick={onDismiss}>
          Работать над одной задачей
        </Btn>
      </div>
    </aside>
  );
}

export function SummaryModal({ summary, onClose }: { summary: Summary; onClose: () => void }) {
  return (
    <div className='overlay' onClick={onClose} role='presentation'>
      <div className='modal' role='dialog' aria-modal='true' aria-labelledby='summary-title' onClick={(e) => e.stopPropagation()}>
        <h2 id='summary-title'>Сессия завершена</h2>
        <p>Рабочих блоков: {formatDuration(summary.workMin)}.</p>
        <h3>Готово</h3>
        {summary.done.length === 0 ? (
          <p className='muted'>Ни одна задача не закончена.</p>
        ) : (
          <ul>
            {summary.done.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        )}
        {summary.unfinished.length > 0 && (
          <>
            <h3>Не закончено</h3>
            <ul>
              {summary.unfinished.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </>
        )}
        <div className='modal-actions'>
          <Btn className='primary' onClick={onClose}>
            Закрыть
          </Btn>
        </div>
      </div>
    </div>
  );
}
