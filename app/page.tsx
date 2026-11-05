'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { authService, AuthMode } from '../lib/auth-service';
import App from './App';
import Btn from './Btn';
import { ErrorHandler } from '../lib/errors/error-handler';

export default function Home() {
  const [authMode, setAuthMode] = useState<'loading' | AuthMode>('loading');
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    (async () => {
      try {
        await authService.init();
      } catch (e) {
        ErrorHandler.handle(e);
      }
      const state = authService.getState();
      setAuthMode(state.mode);
      setUser(state.user);
    })();
  }, []);

  if (authMode === 'loading') {
    return (
      <main className='center'>
        <p className='muted loading'>
          <span className='spin' aria-hidden='true' /> Загрузка…
        </p>
      </main>
    );
  }

  if (authMode === 'guest') return <AuthForm />;

  // Для cloud и local режимов рендерим приложение
  return (
    <App 
      key={user?.id} 
      userId={user?.id ?? ''} 
      email={user?.email ?? ''} 
      authMode={authMode}
    />
  );
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

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'register') {
        const res = await authService.register(email.trim(), password, nickname.trim());
        window.location.reload(); // Перезагрузка для обновления состояния App
      } else {
        const res = await authService.login(identifier.trim(), password);
        window.location.reload();
      }
    } catch (err: any) {
      if (err.message === 'USER_NOT_FOUND_OFFLINE') {
        setError('Пользователь не найден в локальной базе. Попробуйте зарегистрироваться.');
      } else {
        setError(err.message || 'Произошла ошибка');
      }
    } finally {
      setBusy(false);
    }
  };

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
