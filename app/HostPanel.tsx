'use client';

import { useEffect, useState } from 'react';
import { localApi } from '../lib/live-api';
import type { CoworkHost, HostView } from '../lib/cowork/host';
import { localAddresses } from '../lib/cowork/tauri';
import { ErrorMapper } from '../lib/errors/error-mapper';
import type { Participant } from '../lib/types';
import Btn from './Btn';
import { PersonChip } from './PersonChip';

interface Props {
  host: CoworkHost;
  view: HostView;
  workspaceId: string;
  meId: string;
  onClose: () => void;
  onStop: () => void;
}

/** Управление cowork для хоста: код приглашения, заявки на вступление и участники. */
export default function HostPanel({ host, view, workspaceId, meId, onClose, onStop }: Props) {
  const [people, setPeople] = useState<Participant[]>([]);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      localApi
        .getParticipants(workspaceId)
        .then((list) => alive && setPeople(list))
        .catch((e) => alive && setError(ErrorMapper.map(e).message));
    void load();
    const off = localApi.subscribe(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, [workspaceId]);

  useEffect(() => {
    localAddresses().then(setAddresses).catch(() => setAddresses([]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Удаление в два нажатия: первое просит подтвердить, через 3 секунды сбрасывается
  useEffect(() => {
    if (!removing) return;
    const id = setTimeout(() => setRemoving(null), 3000);
    return () => clearTimeout(id);
  }, [removing]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(ErrorMapper.map(e).message);
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.code ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* код виден на экране, его можно переписать */
    }
  };

  const members = people.filter((p) => p.role === 'member' || p.id === meId);
  const code = view.code ?? '';

  return (
    <div className='overlay' onClick={onClose} role='presentation'>
      <div className='modal wide-modal' role='dialog' aria-modal='true' aria-labelledby='host-title' onClick={(e) => e.stopPropagation()}>
        <h2 id='host-title'>Cowork: вы хост</h2>

        <section className='block'>
          <h3>Код приглашения</h3>
          <div className='code-row'>
            <output className='code' aria-label='Код приглашения'>
              {code.slice(0, 3)} {code.slice(3)}
            </output>
            <Btn className='small ghost' onClick={() => void copy()}>
              {copied ? 'Скопировано' : 'Копировать'}
            </Btn>
            <Btn className='small ghost' busy={busy === 'code'} onClick={() => void act('code', () => host.regenerateCode())}>
              Новый код
            </Btn>
          </div>
          <p className='hint'>
            Отправьте код тем, кого хотите добавить. Они должны быть в той же сети Wi-Fi и открыть Taska → Cowork → «Подключиться». Каждого
            нового участника вы подтверждаете сами.
          </p>
          {addresses.length > 0 && (
            <p className='hint'>
              Если вас не видно в списке (бывает в офисных и гостевых сетях), гость может ввести адрес вручную:{' '}
              <b className='mono'>{addresses.map((a) => (view.port && view.port !== 47821 ? `${a}:${view.port}` : a)).join(' или ')}</b>
            </p>
          )}
        </section>

        {view.pending.length > 0 && (
          <section className='block'>
            <h3>Хотят присоединиться ({view.pending.length})</h3>
            <ul className='plain'>
              {view.pending.map((r) => (
                <li key={r.conn} className='person-row'>
                  <b>{r.name}</b>
                  <span className='spacer' />
                  <Btn className='small primary' busy={busy === `acc${r.conn}`} disabled={busy !== null && busy !== `acc${r.conn}`} onClick={() => void act(`acc${r.conn}`, () => host.accept(r.conn))}>
                    Принять
                  </Btn>
                  <Btn className='small ghost' disabled={busy !== null} onClick={() => void act(`rej${r.conn}`, () => host.reject(r.conn))}>
                    Отклонить
                  </Btn>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className='block'>
          <h3>Участники ({members.filter((p) => p.active).length})</h3>
          <ul className='plain'>
            {members.map((p) => {
              const online = p.id === meId || view.online.includes(p.id);
              return (
                <li key={p.id} className='person-row'>
                  <span className={`dot ${online ? 'on' : 'off'}`} title={online ? 'В сети' : 'Не в сети'} />
                  <PersonChip id={p.id} name={p.name} you={p.id === meId} inactive={!p.active} />
                  {p.role === 'host' && <span className='hint'>хост</span>}
                  <span className='spacer' />
                  {p.role === 'member' && p.active && (
                    <Btn
                      className={removing === p.id ? 'small danger' : 'small ghost'}
                      busy={busy === `rm${p.id}`}
                      disabled={busy !== null && busy !== `rm${p.id}`}
                      onClick={() => {
                        if (removing === p.id) {
                          setRemoving(null);
                          void act(`rm${p.id}`, () => host.removeMember(p.id));
                        } else setRemoving(p.id);
                      }}
                    >
                      {removing === p.id ? 'Удалить?' : 'Удалить'}
                    </Btn>
                  )}
                </li>
              );
            })}
          </ul>
          {members.length <= 1 && <p className='hint'>Пока здесь только вы.</p>}
        </section>

        {error && (
          <p className='error' role='alert'>
            {error}
          </p>
        )}
        <p className='hint'>
          Cowork работает, пока Taska открыта на этом компьютере. При первом запуске Windows может спросить разрешение для частных сетей: нажмите
          «Разрешить», иначе гости вас не найдут.
        </p>
        <div className='modal-actions'>
          <Btn className='primary' onClick={onClose}>
            Готово
          </Btn>
          <Btn className='danger' onClick={onStop}>
            Выключить cowork
          </Btn>
        </div>
      </div>
    </div>
  );
}
