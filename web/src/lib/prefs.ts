// 기기별로 기억하는 화면 설정(테마·보기 모드)과 시계.
import { useCallback, useEffect, useState } from 'react';

export const THEME_KEY = 'cs-theme';
export const MODE_KEY = 'cs-mode';

function read(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* 사생활 보호 모드 등 */ }
}

const systemDark = () => {
  try { return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false; } catch { return false; }
};

/** 처음엔 기기 설정을 따르고, 버튼으로 바꾸면 그 값을 기억한다. */
export function useTheme(): { dark: boolean; toggle: () => void; cls: string } {
  const [stored, setStored] = useState<string | null>(() => read(THEME_KEY));
  const [sys, setSys] = useState(systemDark);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq?.addEventListener) return;
    const on = (e: MediaQueryListEvent) => setSys(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const dark = stored === 'dark' || (stored !== 'light' && sys);
  const toggle = useCallback(() => {
    const next = dark ? 'light' : 'dark';
    write(THEME_KEY, next);
    setStored(next);
  }, [dark]);
  return { dark, toggle, cls: dark ? 'dark' : '' };
}

/** 정해진 값 가운데 하나를 기억하는 상태. */
export function useStoredChoice<T extends string>(key: string, options: readonly T[], fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const v = read(key);
    return options.includes(v as T) ? (v as T) : fallback;
  });
  const set = useCallback((v: T) => { write(key, v); setValue(v); }, [key]);
  return [value, set];
}

/** 상대 시간 표시를 위해 주기적으로 다시 그린다. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
