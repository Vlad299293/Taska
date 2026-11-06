'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ClientState } from '../lib/cowork/client';
import { CODE_LENGTH, CoworkError, MAX_NAME_LENGTH, normalizeCode } from '../lib/cowork/protocol';
import type { FoundHost } from '../lib/cowork/protocol';
import { parseAddress } from '../lib/cowork/guest';
import type { GuestTarget } from '../lib/cowork/guest';
import { scanHosts } from '../lib/cowork/tauri';
import { ErrorMapper } from '../lib/errors/error-mapper';
import Btn from './Btn';

interface Props {
  nickname: string;
  /** Состояние подключения: «connecting», пока устанавливается связь, «pending», пока хост решает */
  state: ClientState;
  onJoin: (target: GuestTarget, name: string, code: string) => Promise<void>;
  onCancel: () => void;
  onClose: () => void;
}

/** Подключение гостя к хосту: найти хост в сети (или ввести адрес), имя и код приглашения. */
export default function JoinModal({ nickname, state, onJoin, onCancel, onClose }: Props) {
  const [hosts, setHosts] = useState<FoundHost[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState('');
  const [name, setName] = useState(nickname.slice(0, MAX_NAME_LENGTH));
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const joining = state === 'connecting' || state === 'pending';

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const found = await scanHosts();
      setHosts(found);
      setSelected((cur) => (cur && found.some((f) => key(f) === cur) ? cur : found.length === 1 ? key(found[0]) : null));
    } catch (e) {
      setHosts([]);
      setError(ErrorMapper.map(e).message);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !joining && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, joining]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let target: GuestTarget | null = null;
    if (manual) {
      const parsed = parseAddress(address);
      if (!parsed) return setError('Введите адрес хоста, например 192.168.1.5');
      target = parsed;
    } else {
      const host = hosts?.find((h) => key(h) === selected);
      if (!host) return setError('Выберите хост из списка или введите адрес вручную.');
      target = { hostId: host.hostId, address: host.address, port: host.port };
    }
    if (name.trim().length === 0) return setError('Введите своё имя.');
    if (normalizeCode(code).length !== CODE_LENGTH) return setError(`Код приглашения состоит из ${CODE_LENGTH} символов.`);
    try {
      await onJoin(target, name.trim(), code);
    } catch (err) {
      // Отмена заявки самим пользователем ошибкой не считается
      if (!(err instanceof CoworkError && err.code === 'CANCELLED')) setError(ErrorMapper.map(err).message);
    }
  };

  return (
    <div className='overlay' onClick={() => !joining && onClose()} role='presentation'>
      <form className='modal' role='dialog' aria-modal='true' aria-labelledby='join-title' onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
        <h2 id='join-title'>Подключиться к хосту</h2>

        {!manual && (
          <div className='block'>
            <h3>
              Хосты в вашей сети{' '}
              <button type='button' className='link' disabled={scanning || joining} onClick={() => void scan()}>
                {scanning ? 'Ищем…' : 'Искать снова'}
              </button>
            </h3>
            {hosts === null && (
              <p className='muted loading'>
                <span className='spin' aria-hidden='true' /> Ищем…
              </p>
            )}
            {hosts?.length === 0 && !scanning && (
              <p className='hint'>
                Никого не нашли. Убедитесь, что хост включил cowork и вы в одной сети Wi-Fi, или введите адрес вручную.
              </p>
            )}
            <ul className='plain'>
              {hosts?.map((h) => (
                <li key={key(h)}>
                  <label className={`host-option${selected === key(h) ? ' on' : ''}`}>
                    <input type='radio' name='host' checked={selected === key(h)} disabled={joining} onChange={() => setSelected(key(h))} />
                    <b>{h.name}</b>
                    <span className='hint mono'>{h.address}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {manual && (
          <label className='field'>
            <span>Адрес хоста</span>
            <input value={address} placeholder='192.168.1.5' disabled={joining} autoFocus onChange={(e) => setAddress(e.target.value)} />
          </label>
        )}
        <button type='button' className='link left' disabled={joining} onClick={() => setManual((m) => !m)}>
          {manual ? 'Выбрать из найденных' : 'Ввести адрес вручную'}
        </button>

        <div className='row'>
          <label className='field'>
            <span>Ваше имя для других</span>
            <input value={name} maxLength={MAX_NAME_LENGTH} disabled={joining} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className='field'>
            <span>Код приглашения</span>
            <input
              className='mono code-input'
              value={code}
              maxLength={CODE_LENGTH + 1}
              placeholder='ABC DEF'
              autoCapitalize='characters'
              autoComplete='off'
              spellCheck={false}
              disabled={joining}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </label>
        </div>

        {state === 'pending' && (
          <p className='hint ok' role='status'>
            Заявка отправлена. Ждём, пока хост вас примет…
          </p>
        )}
        {error && (
          <p className='error' role='alert'>
            {error}
          </p>
        )}

        <div className='modal-actions'>
          <Btn type='submit' className='primary' busy={joining}>
            {state === 'pending' ? 'Ждём хоста…' : 'Подключиться'}
          </Btn>
          {joining ? (
            <Btn type='button' className='ghost' onClick={onCancel}>
              Отменить заявку
            </Btn>
          ) : (
            <Btn type='button' className='ghost' onClick={onClose}>
              Закрыть
            </Btn>
          )}
        </div>
      </form>
    </div>
  );
}

const key = (h: FoundHost) => `${h.hostId}@${h.address}:${h.port}`;
