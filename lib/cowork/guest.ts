import type { KeyValueStore } from '../auth-service';
import { CoworkClient } from './client';
import { DEFAULT_WS_PORT } from './protocol';
import type { FoundHost } from './protocol';
import { browserSocketFactory, scanHosts } from './tauri';

/** К какому хосту подключаться. После первого подключения известен hostId, и адрес можно найти заново. */
export interface GuestTarget {
  hostId?: string;
  address: string;
  port: number;
}

/** Сохраняется на компьютере гостя, чтобы после перезапуска вернуться без нового подтверждения хоста. */
export interface SavedMembership {
  memberId: string;
  token: string;
  hostId: string;
  hostName: string;
  name: string;
  address: string;
  port: number;
}

const membershipKey = (userId: string) => `taska.cowork.guest.${userId}`;
const roleKey = (userId: string) => `taska.cowork.role.${userId}`;

function storage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadMembership(userId: string): SavedMembership | null {
  try {
    const raw = storage()?.getItem(membershipKey(userId));
    if (!raw) return null;
    const m = JSON.parse(raw) as SavedMembership;
    return m && typeof m.memberId === 'string' && typeof m.token === 'string' ? m : null;
  } catch {
    return null;
  }
}

export function saveMembership(userId: string, m: SavedMembership): void {
  try {
    storage()?.setItem(membershipKey(userId), JSON.stringify(m));
  } catch {
    /* без хранилища придётся подключаться по коду заново */
  }
}

export function clearMembership(userId: string): void {
  try {
    storage()?.removeItem(membershipKey(userId));
    storage()?.removeItem(roleKey(userId));
  } catch {
    /* ничего страшного */
  }
}

/** Последний режим: чтобы приложение открылось так же, как было закрыто. */
export function rememberRole(userId: string, role: 'solo' | 'guest'): void {
  try {
    storage()?.setItem(roleKey(userId), role);
  } catch {
    /* не критично */
  }
}

export function lastRole(userId: string): 'solo' | 'guest' {
  try {
    return storage()?.getItem(roleKey(userId)) === 'guest' ? 'guest' : 'solo';
  } catch {
    return 'solo';
  }
}

/** Разбирает «192.168.1.5» или «192.168.1.5:47821». */
export function parseAddress(input: string): { address: string; port: number } | null {
  const m = /^\s*([A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?\s*$/.exec(input);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : DEFAULT_WS_PORT;
  if (port < 1 || port > 65535) return null;
  return { address: m[1], port };
}

async function resolveUrl(target: GuestTarget): Promise<string> {
  if (target.hostId) {
    // Адрес в домашней сети может смениться: ищем хост по его id
    const found: FoundHost[] = await scanHosts().catch(() => []);
    const hit = found.find((f) => f.hostId === target.hostId);
    if (hit) {
      target.address = hit.address;
      target.port = hit.port;
    }
  }
  return `ws://${target.address}:${target.port}`;
}

export function createGuestClient(target: GuestTarget): { client: CoworkClient; target: GuestTarget } {
  const t: GuestTarget = { ...target };
  const client = new CoworkClient({ factory: browserSocketFactory, resolveUrl: () => resolveUrl(t) });
  return { client, target: t };
}
