import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { SocketFactory, SocketLike } from './client';
import type { HostTransport, TransportEvent } from './host';
import type { FoundHost } from './protocol';

/** Сеть хоста: сервер и объявление в сети живут в Rust, сюда приходят события соединений. */
export const tauriTransport: HostTransport = {
  start: ({ name, hostId }) => invoke<number>('cowork_host_start', { name, hostId }),
  stop: () => invoke('cowork_host_stop'),
  send: (conn, text) => invoke('cowork_send', { conn, text }),
  kick: (conn) => invoke('cowork_kick', { conn }),
  onEvent(listener) {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<TransportEvent>('cowork-event', (e) => listener(e.payload)).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },
};

/** Хосты в той же локальной сети. */
export const scanHosts = (): Promise<FoundHost[]> => invoke<FoundHost[]>('cowork_scan');

/** IP-адреса этого компьютера, чтобы хост мог продиктовать их гостю при ручном подключении. */
export const localAddresses = (): Promise<string[]> => invoke<string[]>('cowork_local_addresses');

/** Гость подключается к хосту обычным WebSocket браузера: отдельный сетевой код на его стороне не нужен. */
export const browserSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;
