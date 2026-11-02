'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Session as AuthSession } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { NICKNAME_RE, checkNickname, login, register } from '../lib/auth';
import App from './App';
import Btn from './Btn';

export default function Home() {
  const [auth, setAuth] = useState<AuthSession | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setAuth(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setAuth(next));
    return () => data.subscription.unsubscribe();
  }, []);

  if (auth === undefined) {
    return (
      <main className='center'>
        <p className='muted loading'>
          <span className='spin' aria-hidden='true' /> Загрузка…
        </p>
      </main>
    );
  }
  if (!auth) return <AuthForm />;
  return <App key={auth.user.id} userId={auth.user.id} email={auth.user.email ?? ''} />;
}

type Mode = 'login' | 'register';
type NickState = 'idle' | 'checking' | 'free' | 'taken';

function AuthForm() {
  const [mode, setMode] = useState<Mode>('login');
  const [identifier, setIdentifier] = useState('');
  const [nickname, setNickname] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nick, setNick] = useState<NickState>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Проверка уникальности никнейма пока пользователь печатает
  useEffect(() => {
    if (mode !== 'register') return;
    setNick('idle');
    const name = nickname.trim();
    if (!NICKNAME_RE.test(name)) return;
    setNick('checking');
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const free = await checkNickname(name);
        if (!cancelled) setNick(free ? 'free' : 'taken');
      } catch {
        if (!cancelled) setNick('idle');
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [nickname, mode]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === 'register') {
      if (!NICKNAME_RE.test(nickname.trim())) {
        return setError('Никнейм: от 3 до 20 символов, только буквы, цифры, _ и -.');
      }
      if (nick === 'taken') return setError('Этот никнейм уже занят.');
      if (password.length < 8) return setError('Пароль: не короче 8 символов.');
    }
    setBusy(true);
    try {
      if (mode === 'register') await register(nickname.trim(), email.trim(), password);
      else await login(identifier.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const name = nickname.trim();
  const hint =
    name === ''
      ? ''
      : !NICKNAME_RE.test(name)
        ? 'От 3 до 20 символов: буквы, цифры, _ и -.'
        : nick === 'checking'
          ? 'Проверяю…'
          : nick === 'free'
            ? 'Никнейм свободен'
            : nick === 'taken'
              ? 'Этот никнейм занят'
              : '';

  return (
    <main className='center'>
      <div className='login'>
        <h1 className='brand-big'>Taska</h1>
        <p className='muted'>Распределяет дела на ваше время: полчаса на задачу, пять минут на перерыв.</p>
        <div className='tabs' role='tablist'>
          <button type='button' role='tab' className='tab' aria-selected={mode === 'login'} onClick={() => switchMode('login')}>
            Вход
          </button>
          <button type='button' role='tab' className='tab' aria-selected={mode === 'register'} onClick={() => switchMode('register')}>
            Регистрация
          </button>
        </div>
        <form className='form' onSubmit={submit}>
          {mode === 'login' ? (
            <label className='field'>
              <span>Почта или никнейм</span>
              <input value={identifier} autoComplete='username' autoCapitalize='none' onChange={(e) => setIdentifier(e.target.value)} />
            </label>
          ) : (
            <>
              <label className='field'>
                <span>Никнейм</span>
                <input value={nickname} maxLength={20} autoComplete='username' autoCapitalize='none' onChange={(e) => setNickname(e.target.value)} />
                {hint && <small className={nick === 'free' && NICKNAME_RE.test(name) ? 'hint ok' : nick === 'taken' ? 'hint bad' : 'hint'}>{hint}</small>}
              </label>
              <label className='field'>
                <span>Почта</span>
                <input type='email' value={email} autoComplete='email' onChange={(e) => setEmail(e.target.value)} />
              </label>
            </>
          )}
          <label className='field'>
            <span>{mode === 'register' ? 'Пароль (от 8 символов)' : 'Пароль'}</span>
            <input type='password' value={password} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && (
            <p className='error' role='alert'>
              {error}
            </p>
          )}
          <Btn type='submit' className='primary wide' busy={busy}>
            {busy ? (mode === 'register' ? 'Регистрируем…' : 'Входим…') : mode === 'register' ? 'Зарегистрироваться' : 'Войти'}
          </Btn>
        </form>
      </div>
    </main>
  );
}
