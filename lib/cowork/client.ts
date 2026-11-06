import { ALL_METHODS } from '../data-api';
import type { DataApi, LiveApi } from '../data-api';
import { CoworkError, PROTOCOL_VERSION, RPC_TIMEOUT_MS } from './protocol';
import type { ClientMessage, ErrorCode, ServerMessage } from './protocol';

/** Подмножество интерфейса WebSocket, которое нужно клиенту (в тестах подставляется своя реализация). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export type ClientState =
  | 'idle'
  | 'connecting'
  | 'pending' // хост получил заявку и решает, принять ли вас
  | 'online'
  | 'offline' // связь потеряна, идёт переподключение
  | 'rejected'
  | 'removed'
  | 'closed';

export interface Welcome {
  id: string;
  /** Есть только при первом подключении по коду: его нужно сохранить для повторных входов */
  token: string | null;
  workspaceId: string;
  hostName: string;
}

export interface Credentials {
  id: string;
  token: string;
}

export interface CoworkClientOptions {
  factory: SocketFactory;
  /** Адрес хоста. Вызывается при каждой попытке: адрес в локальной сети может измениться. */
  resolveUrl: () => Promise<string>;
  retryMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Гость cowork: те же операции с данными, но они выполняются на хосте. */
export class CoworkClient implements LiveApi {
  private socket: SocketLike | null = null;
  private state: ClientState = 'idle';
  private stateReason: string | null = null;
  private creds: Credentials | null = null;
  private welcome: Welcome | null = null;
  private nextId = 1;
  private readonly calls = new Map<number, PendingCall>();
  private readonly dataListeners = new Set<() => void>();
  private readonly stateListeners = new Set<() => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private attempt = 0; // отличает текущее подключение от устаревших
  private recovering = false; // идёт переподключение после обрыва
  private abortConnect: (() => void) | null = null; // прерывает подключение, которое ещё ждёт ответа

  constructor(private readonly opts: CoworkClientOptions) {
    // Методы DataApi создаются из списка, чтобы клиент и хост не расходились по набору операций
    for (const name of ALL_METHODS) {
      (this as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => this.call(name, args);
    }
  }

  // ---------- Состояние ----------

  getState(): { state: ClientState; reason: string | null; welcome: Welcome | null } {
    return { state: this.state, reason: this.stateReason, welcome: this.welcome };
  }

  onState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => void this.stateListeners.delete(listener);
  }

  subscribe(listener: () => void): () => void {
    this.dataListeners.add(listener);
    return () => void this.dataListeners.delete(listener);
  }

  private setState(state: ClientState, reason: string | null = null): void {
    if (state !== 'offline' && state !== 'connecting' && state !== 'online') this.recovering = false;
    this.state = state;
    this.stateReason = reason;
    for (const l of [...this.stateListeners]) l();
  }

  private notifyData(): void {
    for (const l of [...this.dataListeners]) l();
  }

  // ---------- Подключение ----------

  /** Первое подключение: хост покажет заявку, и промис завершится, когда хост её примет. */
  join(name: string, code: string): Promise<Welcome> {
    return this.connect({ t: 'hello', v: PROTOCOL_VERSION, name, code });
  }

  /** Подключение по сохранённому токену: подтверждение хоста не нужно. */
  resume(creds: Credentials): Promise<Welcome> {
    this.creds = creds;
    return this.connect({ t: 'resume', v: PROTOCOL_VERSION, id: creds.id, token: creds.token });
  }

  /** Выход из cowork: связь закрывается, переподключения не будет. */
  leave(): void {
    this.stopped = true;
    this.clearRetry();
    this.abortConnect?.();
    this.failCalls(new CoworkError('Вы вышли из cowork', 'UNREACHABLE'));
    this.attempt++;
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }

  private connect(hello: ClientMessage): Promise<Welcome> {
    this.stopped = false;
    this.clearRetry();
    // При переподключении остаёмся в «offline», чтобы индикатор не мигал
    if (!this.recovering) this.setState('connecting');
    const attempt = ++this.attempt;
    this.socket?.close();

    return new Promise<Welcome>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (this.abortConnect === abort) this.abortConnect = null;
        fn();
      };
      const abort = () => done(() => reject(new CoworkError('Подключение отменено', 'CANCELLED')));
      this.abortConnect = abort;
      const fail = (error: CoworkError, next: ClientState) => {
        done(() => reject(error));
        if (attempt !== this.attempt) return;
        this.setState(next, error.message);
      };

      this.opts
        .resolveUrl()
        .then((url) => {
          if (attempt !== this.attempt) return done(() => reject(new CoworkError('Подключение отменено', 'UNREACHABLE')));
          const socket = this.opts.factory(url);
          this.socket = socket;

          socket.onopen = () => socket.send(JSON.stringify(hello));
          socket.onerror = () => undefined; // подробности придут в onclose
          socket.onmessage = (event) => {
            if (attempt !== this.attempt) return;
            let msg: ServerMessage;
            try {
              msg = JSON.parse(String(event.data)) as ServerMessage;
            } catch {
              return;
            }
            switch (msg.t) {
              case 'pending':
                this.setState('pending');
                break;
              case 'welcome': {
                const token = msg.token;
                if (token) this.creds = { id: msg.id, token };
                this.welcome = { id: msg.id, token, workspaceId: msg.workspaceId, hostName: msg.hostName };
                const wasRecovering = this.recovering;
                this.recovering = false;
                this.setState('online');
                done(() => resolve(this.welcome as Welcome));
                if (wasRecovering) this.notifyData(); // после обрыва данные могли измениться
                break;
              }
              case 'rejected':
                fail(new CoworkError('Хост отклонил заявку', 'FORBIDDEN'), 'rejected');
                this.dropSocket(socket);
                break;
              case 'removed':
                this.failCalls(new CoworkError('Хост удалил вас из cowork', 'FORBIDDEN'));
                fail(new CoworkError('Хост удалил вас из cowork', 'FORBIDDEN'), 'removed');
                this.dropSocket(socket);
                break;
              case 'error':
                if (this.state === 'online' && msg.code !== 'COWORK_OFF') break;
                this.failCalls(new CoworkError(msg.message, msg.code));
                fail(new CoworkError(msg.message, msg.code), msg.code === 'COWORK_OFF' ? 'closed' : 'rejected');
                this.dropSocket(socket);
                break;
              case 'changed':
                this.notifyData();
                break;
              case 'rpc_result':
                this.finishCall(msg);
                break;
            }
          };
          socket.onclose = () => {
            if (attempt !== this.attempt) return;
            this.socket = null;
            this.failCalls(new CoworkError('Нет связи с хостом', 'UNREACHABLE'));
            if (!settled) return fail(new CoworkError('Не удалось подключиться к хосту', 'UNREACHABLE'), 'offline');
            if (this.state === 'online' || this.state === 'offline') this.lostConnection();
          };
        })
        .catch((e: unknown) => {
          fail(new CoworkError(e instanceof Error ? e.message : 'Хост не найден в сети', 'UNREACHABLE'), 'offline');
        });
    });
  }

  /** Закрывает сокет, не запуская переподключение (хост сам объяснил, почему связь не нужна). */
  private dropSocket(socket: SocketLike): void {
    this.attempt++;
    socket.close();
    if (this.socket === socket) this.socket = null;
  }

  private lostConnection(): void {
    if (this.stopped || !this.creds) return this.setState('closed');
    this.recovering = true;
    this.setState('offline', 'Связь с хостом потеряна, переподключаемся…');
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      const creds = this.creds;
      if (this.stopped || !creds) return;
      this.resume(creds).catch(() => {
        // Хост пока недоступен. Если он явно отказал, состояние уже стало rejected/removed/closed
        if (this.state === 'offline' && !this.stopped) this.lostConnection();
      });
    }, this.opts.retryMs ?? 2000);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  // ---------- Запросы ----------

  private call(method: string, args: unknown[]): Promise<unknown> {
    if (this.state !== 'online' || !this.socket) {
      return Promise.reject(new CoworkError('Нет связи с хостом', 'UNREACHABLE'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new CoworkError('Хост не ответил вовремя', 'UNREACHABLE'));
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      this.calls.set(id, { resolve, reject, timer });
      try {
        this.socket?.send(JSON.stringify({ t: 'rpc', id, method, args } satisfies ClientMessage));
      } catch {
        clearTimeout(timer);
        this.calls.delete(id);
        reject(new CoworkError('Нет связи с хостом', 'UNREACHABLE'));
      }
    });
  }

  private finishCall(msg: Extract<ServerMessage, { t: 'rpc_result' }>): void {
    const call = this.calls.get(msg.id);
    if (!call) return;
    this.calls.delete(msg.id);
    clearTimeout(call.timer);
    if (msg.ok) call.resolve(msg.result);
    else call.reject(new CoworkError(msg.error.message, msg.error.code as ErrorCode));
  }

  private failCalls(error: Error): void {
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.calls.clear();
  }
}

/** Типы методов DataApi добавляются в конструкторе, поэтому объявляем их здесь для компилятора. */
export interface CoworkClient extends DataApi {}
