'use client';

import type { CSSProperties } from 'react';
import { initials, personColor } from '../lib/cowork/people';
import type { Participant, Task } from '../lib/types';

/** Цветной кружок с инициалами и имя: по нему сразу видно, чья это задача. */
export function PersonChip({ id, name, you = false, inactive = false }: { id: string; name: string; you?: boolean; inactive?: boolean }) {
  return (
    <span className={`who${inactive ? ' gone' : ''}`} style={{ '--who': personColor(id) } as CSSProperties} title={inactive ? `${name} (вышел)` : name}>
      <span className='who-dot' aria-hidden='true'>
        {initials(name)}
      </span>
      <span className='who-name'>
        {name}
        {you ? ' (вы)' : ''}
        {inactive ? ' · вышел' : ''}
      </span>
    </span>
  );
}

interface BarProps {
  people: Participant[];
  tasks: Task[];
  meId: string;
  selected: string;
  onSelect: (id: string) => void;
}

/** Фильтр доски по участникам. Показывает, сколько задач у каждого. */
export function PeopleBar({ people, tasks, meId, selected, onSelect }: BarProps) {
  const count = (id: string) => tasks.filter((t) => t.assignee_id === id).length;
  return (
    <nav className='people' aria-label='Участники'>
      <button type='button' className='pill' aria-pressed={selected === 'all'} onClick={() => onSelect('all')}>
        Все <span className='n'>{tasks.length}</span>
      </button>
      {people.map((p) => (
        <button
          key={p.id}
          type='button'
          className={`pill${p.active ? '' : ' gone'}`}
          style={{ '--who': personColor(p.id) } as CSSProperties}
          aria-pressed={selected === p.id}
          onClick={() => onSelect(p.id)}
        >
          <span className='who-dot' aria-hidden='true'>
            {initials(p.name)}
          </span>
          {p.name}
          {p.id === meId ? ' (вы)' : ''}
          {p.role === 'host' ? ' · хост' : ''}
          <span className='n'>{count(p.id)}</span>
        </button>
      ))}
    </nav>
  );
}
