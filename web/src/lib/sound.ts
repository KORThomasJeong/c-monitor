// 웹 알림 소리: 대시보드가 열려 있을 때 세션이 답을 기다리거나(wait) 작업이 끝나면(done) 짧게 울린다.
// 파일 없이 Web Audio로 만든다. 브라우저는 사람이 화면을 한 번 누르기 전에는 소리를 막으므로,
// 첫 동작(누르기·키 입력) 때 AudioContext를 만들어 깨워 두고, 그 전에는 조용히 건너뛴다.
// 켜기·끄기는 브라우저마다(localStorage) 기억한다.

export const SOUND_KEY = 'cs-sound';
export type Chime = 'wait' | 'done';

/** 기본은 켬. 저장소를 못 쓰면 켠 것으로 본다. */
export function isSoundOn(): boolean {
  try { return window.localStorage.getItem(SOUND_KEY) !== '0'; } catch { return true; }
}
export function setSoundOn(on: boolean): void {
  try { window.localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch { /* 사생활 보호 모드 등 */ }
}

type AC = typeof AudioContext;
let ctx: AudioContext | null = null;

function makeCtx(): AudioContext | null {
  if (ctx) return ctx;
  const w = window as unknown as { AudioContext?: AC; webkitAudioContext?: AC };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try { ctx = new Ctor(); } catch { ctx = null; }
  return ctx;
}

/** 사람의 동작 안에서 불러야 소리가 풀린다. */
export function unlockSound(): void {
  const c = makeCtx();
  if (c && c.state === 'suspended') void c.resume().catch(() => {});
}

let installed = false;
/** 첫 누르기·키 입력 때 소리를 깨우는 리스너를 한 번만 단다. 깨어나면 리스너를 뗀다. */
export function installSoundUnlock(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const on = () => {
    unlockSound();
    if (!ctx || ctx.state === 'running') {
      window.removeEventListener('pointerdown', on, true);
      window.removeEventListener('keydown', on, true);
    }
  };
  window.addEventListener('pointerdown', on, true);
  window.addEventListener('keydown', on, true);
}

// wait: 높은 음에서 내려오는 두 번(주의), done: 올라가는 두 번(끝남)
const NOTES: Record<Chime, [freq: number, at: number][]> = {
  wait: [[880, 0], [660, 0.16]],
  done: [[523.25, 0], [783.99, 0.14]],
};

/** 짧은 소리. 아직 소리가 풀리지 않았으면(첫 동작 전) 아무것도 하지 않고 false. */
export function playChime(kind: Chime): boolean {
  const c = ctx;
  if (!c || c.state !== 'running') return false;
  try {
    const t0 = c.currentTime + 0.01;
    for (const [freq, at] of NOTES[kind]) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = t0 + at;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      osc.connect(gain).connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.16);
    }
    return true;
  } catch {
    return false;
  }
}

/** 상태가 바뀐 세션들 가운데 울릴 소리(wait가 done보다 앞선다). 처음 보는 세션·같은 상태는 셈하지 않는다. */
export function chimeFor(prev: ReadonlyMap<string, string>, next: { id: string; status: string }[]): Chime | null {
  let out: Chime | null = null;
  for (const s of next) {
    const p = prev.get(s.id);
    if (!p || p === s.status) continue;
    if (s.status === 'wait') return 'wait';
    if (s.status === 'done') out = 'done';
  }
  return out;
}
