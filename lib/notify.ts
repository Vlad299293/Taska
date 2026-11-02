let ctx: AudioContext | null = null;
let flashTimer: ReturnType<typeof setInterval> | null = null;
let baseTitle = '';

/** Звук разрешается жестом пользователя, поэтому вызывается при нажатии «Старт». */
export function unlockAudio(): void {
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
    }
    void ctx.resume();
  } catch {
    /* звук необязателен */
  }
}

export function beep(kind: 'work' | 'break' | 'end'): void {
  const c = ctx;
  if (!c) return;
  const notes = kind === 'break' ? [660, 520] : kind === 'work' ? [520, 660] : [520, 660, 880];
  const t0 = c.currentTime;
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    const start = t0 + i * 0.25;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.25);
  });
}

export async function askPermission(): Promise<void> {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      /* разрешение необязательно */
    }
  }
}

export function notify(title: string, body: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body });
  } catch {
    /* на некоторых мобильных браузерах недоступно */
  }
}

export function stopFlash(): void {
  if (flashTimer !== null) {
    clearInterval(flashTimer);
    flashTimer = null;
    if (baseTitle) document.title = baseTitle;
  }
}

/** Мигает заголовком вкладки, пока пользователь не вернётся на неё. */
export function flashTitle(text: string): void {
  if (typeof document === 'undefined' || !document.hidden) return;
  stopFlash();
  baseTitle = document.title;
  let on = false;
  flashTimer = setInterval(() => {
    on = !on;
    document.title = on ? text : baseTitle;
  }, 900);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) stopFlash();
  });
}
