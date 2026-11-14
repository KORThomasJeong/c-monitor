// 라이브러리 없이 쓰는 작은 라우터: history.pushState + popstate.
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

if (typeof window !== 'undefined') window.addEventListener('popstate', notify);

/** 화면을 옮긴다. replace면 뒤로 가기 기록을 남기지 않는다. */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const cur = window.location.pathname + window.location.search;
  if (cur === to) return;
  if (opts.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  notify();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const snapshot = () => window.location.pathname + window.location.search;

/** 지금 주소(pathname + search). 바뀌면 다시 그린다. */
export function useLocation(): { pathname: string; search: URLSearchParams } {
  const href = useSyncExternalStore(subscribe, snapshot, snapshot);
  const url = new URL(href, 'http://x');
  return { pathname: url.pathname, search: url.searchParams };
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

/** 같은 앱 안 이동용 링크. 새 탭(ctrl/⌘ 클릭)은 브라우저에 맡긴다. */
export function Link({ to, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
