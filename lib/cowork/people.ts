import type { Participant } from '../types';

/** Цвет участника. Зависит от id, поэтому у каждого он свой и у всех одинаковый на любом компьютере. */
export function personColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  // Золотой угол разводит соседние значения, чтобы близкие id получали заметно разные цвета
  const hue = (h * 137.508) % 360;
  return `hsl(${Math.round(hue)} 62% 62%)`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.trim().slice(0, 2);
  return letters.toUpperCase();
}

export function personName(people: Map<string, Participant>, id: string): string {
  return people.get(id)?.name ?? 'Неизвестный';
}
