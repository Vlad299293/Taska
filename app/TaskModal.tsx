'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Priority } from '../lib/planner';
import type { Task } from '../lib/types';
import Btn from './Btn';

export interface TaskInput {
  title: string;
  estimate_min: number;
  priority: Priority;
  deadline: string | null;
  description: string | null;
}

interface Props {
  task: Task | null;
  canDelete: boolean;
  pending: string | null;
  onSave: (input: TaskInput) => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function TaskModal({ task, canDelete, pending, onSave, onDelete, onClose }: Props) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [estimate, setEstimate] = useState(String(task?.estimate_min ?? 30));
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'medium');
  const [deadline, setDeadline] = useState(task?.deadline ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = title.trim();
    const minutes = Number(estimate);
    if (name.length === 0) return setError('Введите название задачи.');
    if (name.length > 120) return setError('Название не длиннее 120 символов.');
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600 || minutes % 5 !== 0) {
      return setError('Оценка времени: от 5 до 600 минут, шаг 5.');
    }
    const text = description.trim();
    onSave({
      title: name,
      estimate_min: minutes,
      priority,
      deadline: deadline === '' ? null : deadline,
      description: text === '' ? null : text,
    });
  };

  return (
    <div className='overlay' onClick={onClose} role='presentation'>
      <form className='modal' role='dialog' aria-modal='true' aria-labelledby='task-modal-title' onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 id='task-modal-title'>{task ? 'Изменить задачу' : 'Новая задача'}</h2>
        <label className='field'>
          <span>Название</span>
          <input value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className='row'>
          <label className='field'>
            <span>Оценка, минут</span>
            <input type='number' min={5} max={600} step={5} value={estimate} onChange={(e) => setEstimate(e.target.value)} />
          </label>
          <label className='field'>
            <span>Приоритет</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option value='high'>Высокий</option>
              <option value='medium'>Средний</option>
              <option value='low'>Низкий</option>
            </select>
          </label>
        </div>
        <label className='field'>
          <span>Дедлайн</span>
          <input type='date' value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </label>
        <label className='field'>
          <span>Описание</span>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error && (
          <p className='error' role='alert'>
            {error}
          </p>
        )}
        <div className='modal-actions'>
          <Btn type='submit' className='primary' busy={pending === 'save'} disabled={pending !== null && pending !== 'save'}>
            Сохранить
          </Btn>
          <Btn type='button' className='ghost' disabled={pending !== null} onClick={onClose}>
            Отмена
          </Btn>
          {task && canDelete && (
            <Btn type='button' className='danger' busy={pending === 'delete'} disabled={pending !== null && pending !== 'delete'} onClick={onDelete}>
              Удалить
            </Btn>
          )}
        </div>
      </form>
    </div>
  );
}
