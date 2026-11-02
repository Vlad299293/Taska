import { SUPABASE_KEY, SUPABASE_URL, supabase } from './supabase';

export const NICKNAME_RE = /^[A-Za-zА-Яа-яЁё0-9_-]{3,20}$/;

type Reply = Record<string, unknown>;

async function call(body: Reply): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Нет связи с сервером. Проверьте интернет.');
  }
  const data = (await res.json().catch(() => ({}))) as Reply;
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Ошибка сервера. Попробуйте ещё раз.');
  return data;
}

async function applySession(data: Reply): Promise<void> {
  const { error } = await supabase.auth.setSession({
    access_token: String(data.access_token),
    refresh_token: String(data.refresh_token),
  });
  if (error) throw new Error(error.message);
}

export async function checkNickname(nickname: string): Promise<boolean> {
  const data = await call({ action: 'check', nickname });
  return data.available === true;
}

export async function register(nickname: string, email: string, password: string): Promise<void> {
  await applySession(await call({ action: 'register', nickname, email, password }));
}

/** identifier: почта или никнейм */
export async function login(identifier: string, password: string): Promise<void> {
  await applySession(await call({ action: 'login', identifier, password }));
}
