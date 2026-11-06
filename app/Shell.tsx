'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UserProfile } from '../lib/auth-service';
import { dataService } from '../lib/data-service';
import { localApi } from '../lib/live-api';
import { CoworkClient } from '../lib/cowork/client';
import type { ClientState, Welcome } from '../lib/cowork/client';
import { CoworkHost } from '../lib/cowork/host';
import type { HostView } from '../lib/cowork/host';
import { clearMembership, createGuestClient, lastRole, loadMembership, rememberRole, saveMembership } from '../lib/cowork/guest';
import type { GuestTarget } from '../lib/cowork/guest';
import { CoworkError } from '../lib/cowork/protocol';
import { tauriTransport } from '../lib/cowork/tauri';
import { ErrorMapper } from '../lib/errors/error-mapper';
import App from './App';
import type { AppUser } from './App';
import Btn from './Btn';
import HostPanel from './HostPanel';
import JoinModal from './JoinModal';

type Role = 'solo' | 'host' | 'guest';
type Dialog = 'choose' | 'join' | 'panel' | 'leave' | null;

interface Guest {
  client: CoworkClient;
  welcome: Welcome;
}

/**
 * Режимы работы. «Обычный»: личный планер на этом компьютере. «Cowork»: общее рабочее пространство,
 * где вы хост (данные у вас, участников принимаете вы) или гость (данные на компьютере хоста).
 */
export default function Shell({ user, onLogout }: { user: UserProfile; onLogout: () => void }) {
  const [role, setRole] = useState<Role>('solo');
  const [ready, setReady] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [hostView, setHostView] = useState<HostView | null>(null);
  const hostRef = useRef<CoworkHost | null>(null);
  const hostOff = useRef<(() => void) | null>(null);

  const [guest, setGuest] = useState<Guest | null>(null);
  const [guestState, setGuestState] = useState<ClientState>('idle');
  const [joinState, setJoinState] = useState<ClientState>('idle');
  const joinClient = useRef<CoworkClient | null>(null);

  // ---------- Хост ----------

  const startHost = useCallback(
    async (openPanel: boolean) => {
      setBusy(true);
      setNotice(null);
      try {
        const host =
          hostRef.current ??
          new CoworkHost({
            api: localApi,
            transport: tauriTransport,
            workspaceId: user.workspaceId,
            host: { id: user.id, name: user.nickname },
          });
        hostRef.current = host;
        hostOff.current?.();
        hostOff.current = host.subscribe(() => setHostView(host.getView()));
        setHostView(await host.start());
        setRole('host');
        if (openPanel) setDialog('panel');
      } catch (e) {
        setNotice(`Не удалось включить cowork: ${ErrorMapper.map(e).message}`);
        await dataService.setCowork(user.workspaceId, false, null).catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [user.id, user.nickname, user.workspaceId],
  );

  const stopHost = async () => {
    setBusy(true);
    try {
      await hostRef.current?.stop();
    } catch (e) {
      setNotice(ErrorMapper.map(e).message);
    } finally {
      hostOff.current?.();
      hostOff.current = null;
      setHostView(null);
      setRole('solo');
      setDialog(null);
      setBusy(false);
    }
  };

  // ---------- Гость ----------

  const enterGuest = useCallback(
    (client: CoworkClient, welcome: Welcome) => {
      setGuest({ client, welcome });
      setGuestState(client.getState().state);
      setRole('guest');
      setDialog(null);
      rememberRole(user.id, 'guest');
    },
    [user.id],
  );

  const join = async (target: GuestTarget, name: string, code: string) => {
    const { client, target: live } = createGuestClient(target);
    joinClient.current = client;
    const off = client.onState(() => setJoinState(client.getState().state));
    try {
      const welcome = await client.join(name, code);
      live.hostId = welcome.workspaceId;
      if (welcome.token) {
        saveMembership(user.id, {
          memberId: welcome.id,
          token: welcome.token,
          hostId: welcome.workspaceId,
          hostName: welcome.hostName,
          name,
          address: live.address,
          port: live.port,
        });
      }
      enterGuest(client, welcome);
    } catch (e) {
      client.leave();
      throw e;
    } finally {
      off();
      joinClient.current = null;
      setJoinState('idle');
    }
  };

  const cancelJoin = () => joinClient.current?.leave();

  const leaveGuest = () => {
    const g = guest;
    setGuest(null);
    setRole('solo');
    setDialog(null);
    rememberRole(user.id, 'solo');
    g?.client.leave();
  };

  // Состояние связи гостя; окончательные состояния возвращают в обычный режим с объяснением
  useEffect(() => {
    if (!guest) return;
    const sync = () => setGuestState(guest.client.getState().state);
    sync();
    return guest.client.onState(sync);
  }, [guest]);

  useEffect(() => {
    if (role !== 'guest' || !guest) return;
    if (guestState !== 'removed' && guestState !== 'closed' && guestState !== 'rejected') return;
    const { reason } = guest.client.getState();
    // Хост не признал токен или удалил вас: сохранённое членство больше не работает
    if (guestState !== 'closed') clearMembership(user.id);
    setNotice(reason ?? 'Вы вышли из cowork.');
    setGuest(null);
    setRole('solo');
    rememberRole(user.id, 'solo');
  }, [guestState, role, guest, user.id]);

  // ---------- Запуск: вернуться в тот режим, в котором закрыли приложение ----------

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      try {
        const ws = await dataService.getWorkspace(user.workspaceId);
        if (ws.cowork) return void (await startHost(false));
        const saved = loadMembership(user.id);
        if (saved && lastRole(user.id) === 'guest') {
          const { client } = createGuestClient({ hostId: saved.hostId, address: saved.address, port: saved.port });
          try {
            enterGuest(client, await client.resume({ id: saved.memberId, token: saved.token }));
          } catch (e) {
            if (e instanceof CoworkError && e.code === 'BAD_TOKEN') {
              clearMembership(user.id);
              setNotice('Хост больше вас не знает. Подключитесь заново по коду приглашения.');
            } else {
              setNotice(`Хост «${saved.hostName}» сейчас недоступен. Открыт обычный режим; когда хост включится, подключитесь снова через Cowork.`);
            }
          }
        }
      } catch (e) {
        setNotice(ErrorMapper.map(e).message);
      } finally {
        setReady(true);
      }
    })();
  }, [user.id, user.workspaceId, startHost, enterGuest]);

  useEffect(
    () => () => {
      hostOff.current?.();
    },
    [],
  );

  // ---------- Данные для интерфейса ----------

  const appUser = useMemo<AppUser>(
    () =>
      role === 'guest' && guest
        ? { id: guest.welcome.id, workspaceId: guest.welcome.workspaceId, nickname: user.nickname }
        : { id: user.id, workspaceId: user.workspaceId, nickname: user.nickname },
    [role, guest, user.id, user.workspaceId, user.nickname],
  );

  if (!ready) {
    return (
      <main className='center'>
        <p className='muted loading'>
          <span className='spin' aria-hidden='true' /> Загрузка…
        </p>
      </main>
    );
  }

  const online = hostView?.online.length ?? 0;
  const pending = hostView?.pending.length ?? 0;
  const guestOffline = role === 'guest' && guestState === 'offline';

  const bar = (
    <div className='cowork-bar'>
      <div className='mode' role='group' aria-label='Режим работы'>
        <button
          type='button'
          className='mode-btn'
          aria-pressed={role === 'solo'}
          disabled={busy}
          onClick={() => role !== 'solo' && setDialog('leave')}
        >
          Обычный
        </button>
        <button
          type='button'
          className='mode-btn'
          aria-pressed={role !== 'solo'}
          disabled={busy}
          onClick={() => (role === 'solo' ? setDialog('choose') : role === 'host' && setDialog('panel'))}
        >
          Cowork
        </button>
      </div>
      {role === 'host' && (
        <button type='button' className='cw-chip' onClick={() => setDialog('panel')}>
          Вы хост · в сети: {online}
          {pending > 0 && <b className='badge'>{pending}</b>}
        </button>
      )}
      {role === 'guest' && guest && (
        <span className='cw-chip static'>
          <i className={`dot ${guestOffline ? 'off' : 'on'}`} aria-hidden='true' />
          Хост: {guest.welcome.hostName}
        </span>
      )}
    </div>
  );

  return (
    <>
      {notice && (
        <div className='app-banner' role='status'>
          <p>{notice}</p>
          <button type='button' className='link' onClick={() => setNotice(null)}>
            Закрыть
          </button>
        </div>
      )}
      {guestOffline && (
        <div className='app-banner warn' role='status'>
          <p>Связь с хостом потеряна, переподключаемся… Изменения пока недоступны.</p>
        </div>
      )}
      <App
        key={`${role}:${appUser.id}`}
        user={appUser}
        api={role === 'guest' && guest ? guest.client : localApi}
        cowork={role !== 'solo'}
        isHost={role === 'host'}
        headerSlot={bar}
        onLogout={() => {
          if (role === 'guest') leaveGuest();
          // Хост без вошедшего пользователя не должен принимать подключения. Код приглашения сохраняется.
          if (role === 'host') void hostRef.current?.stop();
          onLogout();
        }}
      />

      {dialog === 'choose' && (
        <div className='overlay' onClick={() => setDialog(null)} role='presentation'>
          <div className='modal' role='dialog' aria-modal='true' aria-labelledby='choose-title' onClick={(e) => e.stopPropagation()}>
            <h2 id='choose-title'>Cowork: работать вместе</h2>
            <p className='muted'>Все видят задачи друг друга и понимают, чья какая. Подключаться нужно из одной сети Wi-Fi.</p>
            <button type='button' className='choice' disabled={busy} onClick={() => void startHost(true)}>
              <b>Я хост: создать комнату</b>
              <span>Данные хранятся у вас. Вы приглашаете людей, ставите задачи им и себе. Участники ставят задачи только себе.</span>
            </button>
            <button type='button' className='choice' disabled={busy} onClick={() => setDialog('join')}>
              <b>Подключиться к хосту</b>
              <span>Нужен код приглашения. Ваши личные задачи из обычного режима останутся на месте.</span>
            </button>
            <div className='modal-actions'>
              <Btn className='ghost' onClick={() => setDialog(null)}>
                Отмена
              </Btn>
            </div>
          </div>
        </div>
      )}

      {dialog === 'join' && (
        <JoinModal nickname={user.nickname} state={joinState} onJoin={join} onCancel={cancelJoin} onClose={() => setDialog(null)} />
      )}

      {dialog === 'panel' && role === 'host' && hostView && hostRef.current && (
        <HostPanel
          host={hostRef.current}
          view={hostView}
          workspaceId={user.workspaceId}
          meId={user.id}
          onClose={() => setDialog(null)}
          onStop={() => setDialog('leave')}
        />
      )}

      {dialog === 'leave' && (
        <div className='overlay' onClick={() => setDialog(null)} role='presentation'>
          <div className='modal' role='dialog' aria-modal='true' aria-labelledby='leave-title' onClick={(e) => e.stopPropagation()}>
            <h2 id='leave-title'>{role === 'host' ? 'Выключить cowork?' : 'Выйти из cowork?'}</h2>
            <p className='muted'>
              {role === 'host'
                ? 'Участники отключатся. Их задачи сохранятся у вас и вернутся, когда вы снова включите cowork. В обычном режиме вы увидите только свои задачи.'
                : 'Вы вернётесь в обычный режим. Ваши задачи в cowork останутся у хоста, и вы сможете подключиться снова без нового кода.'}
            </p>
            <div className='modal-actions'>
              <Btn className='danger' busy={busy} onClick={() => (role === 'host' ? void stopHost() : leaveGuest())}>
                {role === 'host' ? 'Выключить' : 'Выйти'}
              </Btn>
              <Btn className='ghost' disabled={busy} onClick={() => setDialog(role === 'host' ? 'panel' : null)}>
                Отмена
              </Btn>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
