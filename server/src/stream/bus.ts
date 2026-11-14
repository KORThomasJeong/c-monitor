// 사용자별 이벤트 버스(프로세스 내 메모리). 한 사용자의 메시지는 그 사용자의 구독자에게만 간다.
import type { StreamMessage } from '@c-monitor/shared';
import type { Bus } from '../types';

export function createBus(): Bus {
  const subs = new Map<string, Set<(msg: StreamMessage) => void>>();
  return {
    publish(userId, msg) {
      const set = subs.get(userId);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(msg);
        } catch (err) {
          console.error('[bus] 구독자 오류:', err);
        }
      }
    },
    subscribe(userId, fn) {
      let set = subs.get(userId);
      if (!set) subs.set(userId, (set = new Set()));
      set.add(fn);
      return () => {
        const cur = subs.get(userId);
        if (!cur) return;
        cur.delete(fn);
        if (cur.size === 0) subs.delete(userId);
      };
    },
  };
}
