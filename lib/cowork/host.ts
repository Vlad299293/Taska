import { ErrorMapper } from '../errors/error-mapper';
import { dataService } from '../data-service';
import type { NotifyingLiveApi } from '../live-api';
import {
  CoworkError,
  MAX_CODE_ATTEMPTS,
  MAX_NAME_LENGTH,
  MAX_PENDING_REQUESTS,
  PROTOCOL_VERSION,
  generateInviteCode,
  generateToken,
  normalizeCode,
  safeEqual,
  sha256Hex,
} from './protocol';
import type { ClientMessage, RpcError, ServerMessage } from './protocol';
import { executeRpc } from './rpc';

export type TransportEvent =
  | { type: 'connected'; conn: number }
  | { type: 'text'; conn: number; text: string }
  | { type: 'closed'; conn: number };

/** Сетевая часть хоста. В приложении её реализует Rust, в тестах — заглушка в памяти. */
export interface HostTransport {
  /** Начинает слушать и объявлять хост в локальной сети. Возвращает порт. */
  start(info: { name: string; hostId: string }): Promise<number>;
  stop(): Promise<void>;
  send(conn: number, text: string): Promise<void>;
  kick(conn: number): Promise<void>;
  onEvent(listener: (event: TransportEvent) => void): () => void;
}

export interface PendingRequest {
  conn: number;
  name: string;
}

export interface HostView {
  running: boolean;
  port: number | null;
  code: string | null;
  pending: PendingRequest[];
  /** id участников, которые сейчас на связи */
  online: string[];
}

interface NewConn {
  state: 'new' | 'checking';
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
}
type Conn = NewConn | { state: 'pending'; name: string } | { state: 'active'; profileId: string };

const AUTH_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_CHARS = 256_000;

export interface CoworkHostOptions {
  api: NotifyingLiveApi;
  transport: HostTransport;
  workspaceId: string;
  /** Профиль хоста: он же владелец рабочего пространства */
  host: { id: string; name: string };
}

export class CoworkHost {
  private readonly conns = new Map<number, Conn>();
  private readonly listeners = new Set<() => void>();
  private running = false;
  private port: number | null = null;
  private code: string | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly opts: CoworkHostOptions) {}

  // ---------- Жизненный цикл ----------

  async start(): Promise<HostView> {
    if (this.running) return this.getView();
    const ws = await dataService.getWorkspace(this.opts.workspaceId);
    this.code = ws.inviteCode ?? generateInviteCode();

    this.unsubscribers.push(this.opts.transport.onEvent((e) => void this.onTransport(e)));
    this.unsubscribers.push(this.opts.api.subscribe(() => this.broadcast({ t: 'changed' })));
    try {
      this.port = await this.opts.transport.start({ name: this.opts.host.name, hostId: this.opts.workspaceId });
    } catch (e) {
      this.detach();
      throw e;
    }
    await dataService.setCowork(this.opts.workspaceId, true, this.code);
    this.running = true;
    this.emit();
    return this.getView();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.broadcast({ t: 'error', code: 'COWORK_OFF', message: 'Хост выключил режим cowork' });
    await this.opts.transport.stop();
    this.detach();
    for (const c of this.conns.values()) if ('timer' in c && c.timer) clearTimeout(c.timer);
    this.conns.clear();
    this.port = null;
    await dataService.setCowork(this.opts.workspaceId, false, this.code);
    this.emit();
  }

  /** Новый код: старый перестаёт работать для новых заявок. Уже принятые участники подключаются по токену. */
  async regenerateCode(): Promise<void> {
    this.code = generateInviteCode();
    await dataService.setCowork(this.opts.workspaceId, this.running, this.code);
    this.emit();
  }

  private detach(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  // ---------- Состояние для интерфейса ----------

  getView(): HostView {
    const pending: PendingRequest[] = [];
    const online: string[] = [];
    for (const [conn, c] of this.conns) {
      if (c.state === 'pending') pending.push({ conn, name: c.name });
      if (c.state === 'active') online.push(c.profileId);
    }
    return { running: this.running, port: this.port, code: this.code, pending, online };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  // ---------- Решения хоста ----------

  /** Принимает заявку: создаёт участника и выдаёт ему токен для повторных подключений. */
  async accept(conn: number): Promise<void> {
    const c = this.conns.get(conn);
    if (!c || c.state !== 'pending') return;
    const name = await this.uniqueName(c.name);
    const token = generateToken();
    const profileId = await dataService.addMember(this.opts.workspaceId, name, await sha256Hex(token));
    // Пока шло сохранение, гость мог отключиться
    if (this.conns.get(conn) !== c) {
      this.opts.api.notify();
      return;
    }
    this.conns.set(conn, { state: 'active', profileId });
    await this.send(conn, { t: 'welcome', id: profileId, token, workspaceId: this.opts.workspaceId, hostName: this.opts.host.name });
    this.opts.api.notify();
    this.emit();
  }

  async reject(conn: number): Promise<void> {
    const c = this.conns.get(conn);
    if (!c || c.state !== 'pending') return;
    await this.send(conn, { t: 'rejected' });
    await this.drop(conn);
  }

  /** Удаляет участника: его токен перестаёт работать, а задачи остаются у него в списке. */
  async removeMember(profileId: string): Promise<void> {
    if (profileId === this.opts.host.id) return;
    await dataService.removeMember(this.opts.workspaceId, profileId);
    for (const [conn, c] of this.conns) {
      if (c.state === 'active' && c.profileId === profileId) {
        await this.send(conn, { t: 'removed' });
        await this.drop(conn);
      }
    }
    this.opts.api.notify();
    this.emit();
  }

  private async uniqueName(wanted: string): Promise<string> {
    const taken = new Set((await dataService.getParticipants(this.opts.workspaceId)).map((p) => p.name.toLowerCase()));
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; ; n++) {
      const candidate = `${wanted.slice(0, MAX_NAME_LENGTH - 2)} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  // ---------- Сеть ----------

  private async onTransport(e: TransportEvent): Promise<void> {
    if (!this.running) return;
    if (e.type === 'connected') {
      const timer = setTimeout(() => {
        const c = this.conns.get(e.conn);
        if (c && (c.state === 'new' || c.state === 'checking')) void this.drop(e.conn);
      }, AUTH_TIMEOUT_MS);
      timer.unref?.();
      this.conns.set(e.conn, { state: 'new', attempts: 0, timer });
    } else if (e.type === 'closed') {
      const c = this.conns.get(e.conn);
      if (c && 'timer' in c && c.timer) clearTimeout(c.timer);
      this.conns.delete(e.conn);
      this.emit();
    } else {
      await this.onText(e.conn, e.text);
    }
  }

  private async onText(conn: number, text: string): Promise<void> {
    const c = this.conns.get(conn);
    if (!c || text.length > MAX_MESSAGE_CHARS) return void (await this.drop(conn));

    let msg: ClientMessage;
    try {
      msg = JSON.parse(text) as ClientMessage;
      if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') throw new Error('shape');
    } catch {
      return void (await this.fail(conn, 'BAD_REQUEST', 'Непонятное сообщение'));
    }

    if (c.state === 'active') {
      if (msg.t === 'rpc') await this.onRpc(conn, c.profileId, msg);
      return;
    }
    if (c.state !== 'new') return; // заявка на рассмотрении или идёт проверка: лишние сообщения игнорируем

    if (msg.t === 'hello') await this.onHello(conn, c, msg);
    else if (msg.t === 'resume') await this.onResume(conn, c, msg);
    else await this.fail(conn, 'BAD_REQUEST', 'Сначала нужно представиться');
  }

  private async onHello(conn: number, c: NewConn, msg: Extract<ClientMessage, { t: 'hello' }>) {
    if (msg.v !== PROTOCOL_VERSION) return void (await this.fail(conn, 'BAD_REQUEST', 'Версии приложения хоста и гостя не совпадают'));
    const name = typeof msg.name === 'string' ? msg.name.trim() : '';
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      return void (await this.fail(conn, 'BAD_REQUEST', `Имя: от 1 до ${MAX_NAME_LENGTH} символов`));
    }
    const code = typeof msg.code === 'string' ? normalizeCode(msg.code) : '';
    if (!this.code || !safeEqual(code, this.code)) {
      c.attempts++;
      await this.send(conn, { t: 'error', code: 'BAD_CODE', message: 'Неверный код приглашения' });
      if (c.attempts >= MAX_CODE_ATTEMPTS) await this.drop(conn);
      return;
    }
    if (this.getView().pending.length >= MAX_PENDING_REQUESTS) {
      return void (await this.fail(conn, 'TOO_MANY', 'Слишком много заявок. Попробуйте позже'));
    }
    if (c.timer) clearTimeout(c.timer);
    this.conns.set(conn, { state: 'pending', name });
    await this.send(conn, { t: 'pending' });
    this.emit();
  }

  private async onResume(conn: number, c: NewConn, msg: Extract<ClientMessage, { t: 'resume' }>) {
    if (msg.v !== PROTOCOL_VERSION) return void (await this.fail(conn, 'BAD_REQUEST', 'Версии приложения хоста и гостя не совпадают'));
    if (typeof msg.id !== 'string' || typeof msg.token !== 'string') return void (await this.fail(conn, 'BAD_REQUEST', 'Некорректные данные'));
    c.state = 'checking';
    const stored = await dataService.getMemberTokenHash(this.opts.workspaceId, msg.id);
    const given = await sha256Hex(msg.token);
    if (!stored || !safeEqual(stored, given)) {
      return void (await this.fail(conn, 'BAD_TOKEN', 'Хост вас не знает. Подключитесь заново по коду'));
    }
    if (this.conns.get(conn) !== c) return; // пока проверяли, соединение закрылось
    // Тот же участник подключился с другого окна: старое соединение закрываем
    for (const [other, oc] of this.conns) {
      if (other !== conn && oc.state === 'active' && oc.profileId === msg.id) await this.drop(other);
    }
    if (c.timer) clearTimeout(c.timer);
    this.conns.set(conn, { state: 'active', profileId: msg.id });
    await this.send(conn, { t: 'welcome', id: msg.id, token: null, workspaceId: this.opts.workspaceId, hostName: this.opts.host.name });
    this.emit();
  }

  private async onRpc(conn: number, profileId: string, msg: Extract<ClientMessage, { t: 'rpc' }>): Promise<void> {
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string' || !Array.isArray(msg.args)) return;
    try {
      // Участника могли удалить, пока соединение открыто
      if ((await dataService.getMemberTokenHash(this.opts.workspaceId, profileId)) === null) {
        await this.send(conn, { t: 'removed' });
        return void (await this.drop(conn));
      }
      const result = await executeRpc(
        this.opts.api,
        { workspaceId: this.opts.workspaceId, callerId: profileId, isHost: false },
        msg.method,
        msg.args,
      );
      await this.send(conn, { t: 'rpc_result', id: msg.id, ok: true, result: result ?? null });
    } catch (e) {
      await this.send(conn, { t: 'rpc_result', id: msg.id, ok: false, error: this.toRpcError(e) });
    }
  }

  private toRpcError(e: unknown): RpcError {
    if (e instanceof CoworkError) return { code: e.code, message: e.message };
    const mapped = ErrorMapper.map(e);
    if (mapped.code === 'CHECK_FAILED' || mapped.code === 'DUPLICATE_ENTRY') return { code: 'BAD_REQUEST', message: mapped.message };
    console.error('[cowork-host] rpc failed', e);
    return { code: 'INTERNAL', message: 'Хост не смог выполнить действие' };
  }

  private async fail(conn: number, code: RpcError['code'], message: string): Promise<void> {
    await this.send(conn, { t: 'error', code, message });
    await this.drop(conn);
  }

  private async drop(conn: number): Promise<void> {
    const c = this.conns.get(conn);
    if (c && 'timer' in c && c.timer) clearTimeout(c.timer);
    this.conns.delete(conn);
    try {
      await this.opts.transport.kick(conn);
    } catch {
      /* соединение уже закрыто */
    }
    this.emit();
  }

  private async send(conn: number, msg: ServerMessage): Promise<void> {
    try {
      await this.opts.transport.send(conn, JSON.stringify(msg));
    } catch {
      /* гость отключился: закрытие придёт отдельным событием */
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const [conn, c] of this.conns) if (c.state === 'active') void this.send(conn, msg);
  }
}
