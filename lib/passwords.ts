/**
 * Хеширование паролей через PBKDF2-SHA256 (Web Crypto: работает и в WebView Tauri, и в Node).
 * Формат хранения: pbkdf2$<итерации>$<соль base64>$<хеш base64>.
 */
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, expected] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterations || !salt || !expected) return false;
  const actual = await derive(password, fromBase64(salt), Number(iterations));
  const want = fromBase64(expected);
  if (actual.length !== want.length) return false;
  // Сравнение без раннего выхода, чтобы не выдавать совпавший префикс по времени
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ want[i];
  return diff === 0;
}
