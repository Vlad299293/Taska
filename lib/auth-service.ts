import { localDb } from './db-local';
import { AuthError, ValidationError } from './errors/app-error';
import { hashPassword, verifyPassword } from './passwords';

export const NICKNAME_RE = /^[A-Za-zА-Яа-яЁё0-9_-]{3,20}$/;
export const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACTIVE_USER_KEY = 'taska.activeUser';

export interface UserProfile {
  id: string;
  email: string;
  nickname: string;
  workspaceId: string;
}

interface ProfileRow {
  id: string;
  email: string;
  nickname: string;
  password_hash: string;
  workspace_id: string;
}

/** Где запоминать, кто вошёл. В приложении это localStorage, в тестах подставляется своё хранилище. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): KeyValueStore {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* доступ к хранилищу может быть запрещён */
  }
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
  };
}

const PROFILE_SELECT = `
  SELECT p.id, p.email, p.nickname, p.password_hash, w.id AS workspace_id
  FROM local_profiles p
  JOIN workspaces w ON w.owner_id = p.id`;

function toUser(row: ProfileRow): UserProfile {
  return { id: row.id, email: row.email, nickname: row.nickname, workspaceId: row.workspace_id };
}

class AuthService {
  private user: UserProfile | null = null;
  private store: KeyValueStore | null = null;

  setStore(store: KeyValueStore): void {
    this.store = store;
  }

  private get storage(): KeyValueStore {
    if (!this.store) this.store = defaultStore();
    return this.store;
  }

  /** Открывает базу и восстанавливает пользователя, который вошёл в прошлый раз. */
  async init(): Promise<UserProfile | null> {
    await localDb.init();
    this.user = null;
    const id = this.storage.getItem(ACTIVE_USER_KEY);
    if (id) {
      const rows = await localDb.query<ProfileRow>(`${PROFILE_SELECT} WHERE p.id = ?`, [id]);
      if (rows[0]) this.user = toUser(rows[0]);
      else this.storage.removeItem(ACTIVE_USER_KEY);
    }
    return this.user;
  }

  async register(nickname: string, email: string, password: string): Promise<UserProfile> {
    const nick = nickname.trim();
    const mail = email.trim();
    if (!NICKNAME_RE.test(nick)) {
      throw new ValidationError('Никнейм: от 3 до 20 символов, буквы, цифры, «_» и «-».', 'INVALID_NICKNAME');
    }
    if (!EMAIL_RE.test(mail)) throw new ValidationError('Введите корректную почту.', 'INVALID_EMAIL');
    if (password.length < MIN_PASSWORD) {
      throw new ValidationError(`Пароль не короче ${MIN_PASSWORD} символов.`, 'WEAK_PASSWORD');
    }

    const taken = await localDb.query<{ nickname: string; email: string }>(
      'SELECT nickname, email FROM local_profiles WHERE nickname = ? OR email = ?',
      [nick, mail],
    );
    if (taken.some((r) => r.nickname.toLowerCase() === nick.toLowerCase())) {
      throw new ValidationError('Этот никнейм уже занят.', 'NICKNAME_TAKEN');
    }
    if (taken.length > 0) throw new ValidationError('Эта почта уже зарегистрирована.', 'EMAIL_TAKEN');

    const id = crypto.randomUUID();
    await localDb.execute(
      'INSERT INTO local_profiles (id, email, nickname, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, mail, nick, await hashPassword(password), new Date().toISOString()],
    );
    return this.startSession(id);
  }

  /** identifier: почта или никнейм */
  async login(identifier: string, password: string): Promise<UserProfile> {
    const ident = identifier.trim();
    const rows = await localDb.query<ProfileRow>(`${PROFILE_SELECT} WHERE p.email = ? OR p.nickname = ?`, [ident, ident]);
    const row = rows[0];
    // Одинаковый ответ для «нет такого пользователя» и «неверный пароль», чтобы не подсказывать, что существует
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      throw new AuthError('Неверный логин или пароль.', 'BAD_CREDENTIALS');
    }
    return this.startSession(row.id);
  }

  logout(): void {
    this.user = null;
    this.storage.removeItem(ACTIVE_USER_KEY);
  }

  getUser(): UserProfile | null {
    return this.user;
  }

  private async startSession(userId: string): Promise<UserProfile> {
    const rows = await localDb.query<ProfileRow>(`${PROFILE_SELECT} WHERE p.id = ?`, [userId]);
    if (!rows[0]) throw new AuthError('Профиль не найден.', 'PROFILE_NOT_FOUND');
    this.user = toUser(rows[0]);
    this.storage.setItem(ACTIVE_USER_KEY, userId);
    return this.user;
  }
}

export const authService = new AuthService();
