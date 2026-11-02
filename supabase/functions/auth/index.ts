import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const NICKNAME = /^[A-Za-zА-Яа-яЁё0-9_-]{3,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BAD_LOGIN = 'Неверный логин или пароль.';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Метод не поддерживается.' });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Некорректный запрос.' });
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, opts);
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, opts);
  const action = String(body.action ?? '');

  const signIn = async (email: string, password: string) => {
    const res = await anon.auth.signInWithPassword({ email, password });
    if (res.error || !res.data.session) return null;
    return { access_token: res.data.session.access_token, refresh_token: res.data.session.refresh_token };
  };

  if (action === 'check') {
    const nickname = String(body.nickname ?? '').trim();
    if (!NICKNAME.test(nickname)) return json(200, { available: false });
    const res = await admin.rpc('nickname_available', { p_nickname: nickname });
    if (res.error) return json(500, { error: 'Не удалось проверить никнейм.' });
    return json(200, { available: res.data === true });
  }

  if (action === 'register') {
    const nickname = String(body.nickname ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!NICKNAME.test(nickname)) {
      return json(400, { error: 'Никнейм: от 3 до 20 символов, только буквы, цифры, _ и -.' });
    }
    if (!EMAIL.test(email) || email.length > 254) return json(400, { error: 'Введите корректную почту.' });
    if (password.length < 8 || password.length > 72) return json(400, { error: 'Пароль: от 8 до 72 символов.' });

    const free = await admin.rpc('nickname_available', { p_nickname: nickname });
    if (free.error) return json(500, { error: 'Не удалось проверить никнейм.' });
    if (free.data !== true) return json(409, { error: 'Этот никнейм уже занят.' });

    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { nickname },
    });
    if (created.error) {
      if (created.error.code === 'email_exists') return json(409, { error: 'Эта почта уже зарегистрирована.' });
      return json(500, { error: 'Не удалось создать аккаунт. Возможно, никнейм только что заняли.' });
    }
    const session = await signIn(email, password);
    if (!session) return json(500, { error: 'Аккаунт создан, но войти не удалось. Попробуйте войти вручную.' });
    return json(200, session);
  }

  if (action === 'login') {
    const identifier = String(body.identifier ?? '').trim();
    const password = String(body.password ?? '');
    if (!identifier || !password) return json(400, { error: 'Введите логин и пароль.' });
    let email = identifier.toLowerCase();
    if (!identifier.includes('@')) {
      const found = await admin.rpc('email_for_nickname', { p_nickname: identifier });
      email = typeof found.data === 'string' ? found.data : '';
    }
    if (!email) return json(401, { error: BAD_LOGIN });
    const session = await signIn(email, password);
    if (!session) return json(401, { error: BAD_LOGIN });
    return json(200, session);
  }

  return json(400, { error: 'Неизвестное действие.' });
});
