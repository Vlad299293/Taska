import { MUTATING_METHODS } from './data-api';
import type { DataApi, LiveApi } from './data-api';
import { dataService } from './data-service';

export type NotifyingLiveApi = LiveApi & { notify(): void };

/** Оборачивает Api: после любого изменения данных оповещает подписчиков (интерфейс перечитывает список). */
export function createLiveApi(base: DataApi): NotifyingLiveApi {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch (e) {
        console.error('[live-api] listener failed', e);
      }
    }
  };

  const wrapped: Record<string, unknown> = { ...base };
  for (const name of MUTATING_METHODS) {
    const original = base[name] as (...args: unknown[]) => Promise<unknown>;
    wrapped[name] = async (...args: unknown[]) => {
      const result = await original.apply(base, args);
      notify();
      return result;
    };
  }
  wrapped.subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  wrapped.notify = notify;
  return wrapped as unknown as NotifyingLiveApi;
}

/** Данные на этом компьютере: обычный режим и хост cowork. */
export const localApi = createLiveApi(dataService);
