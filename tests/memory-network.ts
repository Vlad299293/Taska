import type { HostTransport, TransportEvent } from '../lib/cowork/host.ts';
import type { SocketFactory, SocketLike } from '../lib/cowork/client.ts';

/**
 * Сеть в памяти: хост и гости разговаривают через неё так же, как через WebSocket,
 * но без портов. Доставка асинхронная, чтобы порядок сообщений был как в реальной сети.
 */
export function memoryNetwork() {
  let listener: ((e: TransportEvent) => void) | null = null;
  let listening = false;
  let nextConn = 1;
  const sockets = new Map<number, MemSocket>();
  const later = (fn: () => void) => setImmediate(fn);

  class MemSocket implements SocketLike {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    conn = 0;
    closed = false;

    constructor() {
      later(() => {
        if (this.closed) return;
        if (!listening) return this.finish(); // порт никто не слушает: соединение отклонено
        this.conn = nextConn++;
        sockets.set(this.conn, this);
        listener?.({ type: 'connected', conn: this.conn });
        this.onopen?.();
      });
    }

    send(data: string): void {
      if (this.closed) throw new Error('closed');
      const conn = this.conn;
      later(() => listener?.({ type: 'text', conn, text: data }));
    }

    close(): void {
      if (this.closed) return;
      const conn = this.conn;
      this.finish();
      if (conn) later(() => listener?.({ type: 'closed', conn }));
    }

    /** Закрытие со стороны сети */
    finish(): void {
      if (this.closed) return;
      this.closed = true;
      sockets.delete(this.conn);
      later(() => this.onclose?.());
    }

    deliver(text: string): void {
      later(() => {
        if (!this.closed) this.onmessage?.({ data: text });
      });
    }
  }

  const transport: HostTransport = {
    async start() {
      listening = true;
      return 47821;
    },
    async stop() {
      listening = false;
      // как и в настоящем сервере: накопленные сообщения успевают уйти до закрытия
      for (const s of [...sockets.values()]) later(() => later(() => s.finish()));
    },
    async send(conn, text) {
      const s = sockets.get(conn);
      if (!s) throw new Error('no such connection');
      s.deliver(text);
    },
    async kick(conn) {
      const s = sockets.get(conn);
      if (!s) return;
      // даём доставиться последним сообщениям перед закрытием
      later(() => later(() => s.finish()));
    },
    onEvent(cb) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  };

  const factory: SocketFactory = () => new MemSocket();

  return {
    transport,
    factory,
    /** Рвёт все соединения, как будто пропал Wi-Fi (хост продолжает слушать) */
    dropAll() {
      for (const s of [...sockets.values()]) {
        const conn = s.conn;
        s.finish();
        later(() => listener?.({ type: 'closed', conn }));
      }
    },
  };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, what = 'условие', ms = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`Не дождались: ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}
