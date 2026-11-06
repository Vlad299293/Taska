import type { DataApi } from '../data-api';

/** Порты: WebSocket-сервер хоста и UDP-ответчик для поиска хоста в локальной сети. */
export const DEFAULT_WS_PORT = 47821;
export const DISCOVERY_PORT = 47822;

export const PROTOCOL_VERSION = 1;
export const MAX_NAME_LENGTH = 20;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_PENDING_REQUESTS = 10;
export const RPC_TIMEOUT_MS = 10_000;

// ---------- Сообщения гость → хост ----------

export type ClientMessage =
  | { t: 'hello'; v: number; name: string; code: string }
  | { t: 'resume'; v: number; id: string; token: string }
  | { t: 'rpc'; id: number; method: string; args: unknown[] };

// ---------- Сообщения хост → гость ----------

export type ErrorCode =
  | 'BAD_CODE'
  | 'BAD_TOKEN'
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TOO_MANY'
  | 'COWORK_OFF'
  | 'UNREACHABLE'
  | 'CANCELLED'
  | 'INTERNAL';

export interface RpcError {
  code: ErrorCode;
  message: string;
}

export type ServerMessage =
  | { t: 'pending' }
  | { t: 'welcome'; id: string; token: string | null; workspaceId: string; hostName: string }
  | { t: 'rejected' }
  | { t: 'removed' }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'changed' }
  | { t: 'rpc_result'; id: number; ok: true; result: unknown }
  | { t: 'rpc_result'; id: number; ok: false; error: RpcError };

/** Что хост рассказывает о себе при поиске в локальной сети. */
export interface DiscoveryInfo {
  v: number;
  name: string;
  port: number;
  hostId: string;
}

/** Найденный в сети хост (адрес добавляет Rust по источнику ответа). */
export interface FoundHost extends DiscoveryInfo {
  address: string;
}

export class CoworkError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
  ) {
    super(message);
    this.name = 'CoworkError';
  }
}

export type RpcMethod = keyof DataApi;

// ---------- Код приглашения и токены ----------

// Без похожих символов (0/O, 1/I/L), чтобы код легко диктовать голосом
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export function generateInviteCode(): string {
  let code = '';
  // Отбрасываем значения, которые дали бы перекос по алфавиту
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (code.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && code.length < CODE_LENGTH) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return code;
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Секрет участника: показывается гостю один раз, на хосте хранится только хеш. */
export function generateToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Сравнение строк без раннего выхода: время ответа не выдаёт совпавший префикс. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
