'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { authService, MIN_PASSWORD } from '../lib/auth-service';
import type { UserProfile } from '../lib/auth-service';
import { ErrorMapper } from '../lib/errors/error-mapper';
import App from './App';
import Btn from './Btn';

export default function Home() {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [failure, setFailure] = useState('');

  useEffect(() => {
    authService
      .init()
      .then((u) => {
        setUser(u);
        setState('ready');
      })
      .catch((e) => {
        setFailure(ErrorMapper.map(e).message);
        setState('failed');
      });
  }, []);

  if (state === 'loading') {
    return (
      <main className='center'>
        <p className='muted loading'>
          <span className='spin' aria-hidden='true' /> Загрузка…
        </p>
      </main>
    );
  }

  if (state === 'failed') {
    return (
      <main className='center'>
        <p className='error' role='alert'>
          {failure}
        </p>
      </main>
    );
  }

  if (!user) return <AuthForm onAuth={setUser} />;

  return (
    <App
      key={user.id}
      user={user}
      onLogout={() => {
        authService.logout();
        setUser(null);
      }}
    />
  );
}

type Mode = 'login' | 'register';

function AuthForm({ onAuth }: { onAuth: (user: UserProfile) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [identifier, setIdentifier] = useState('');
  const [nickname, setNickname] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
      const user =
        mode === 'register'
          ? await authService.register(nickname, email, password)
          : await authService.login(identifier, password);
      onAuth(user);
    } catch (err) {
      setError(ErrorMapper.map(err).message);
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
            <span>{mode === 'register' ? `Пароль (от ${MIN_PASSWORD} символов)` : 'Пароль'}</span>
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
