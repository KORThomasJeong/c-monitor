// 원격 답장의 대기자 목록(프로세스 내 메모리).
// - 승인·질문: wait 요청이 답을 기다린다(요청 id별 여러 명 가능).
// - 글: 세션마다 inbox 대기자는 한 명. 새 대기자가 붙으면 옛 대기자는 gone으로 끝난다.
import type { ReplyInboxResponse } from '@c-monitor/shared';

export type InboxWaiter = {
  readonly sessionId: string;
  readonly machineId: string;
  readonly waiterId: string;
  readonly promise: Promise<ReplyInboxResponse>;
  /** 이미 끝났는가(글을 받았거나 받기로 정해졌거나, 시간이 다 됐거나, 연결이 끊겼다). */
  readonly settled: boolean;
  /** 결과를 정한다. 이미 끝난 대기자면 false. */
  resolve(result: ReplyInboxResponse): boolean;
  /**
   * 이 대기자를 "곧 결과를 줄 것"으로 잡아 둔다 — 그 뒤로는 시간 초과·끊김으로 끝나지 않는다.
   * 이미 끝난 대기자면 false. 잡았으면 반드시 finish로 결과를 줘야 한다.
   */
  claim(): boolean;
  finish(result: ReplyInboxResponse): void;
};

export type ReplyHub = {
  /** 그 요청에 변화(답·gone)가 생기면 풀리는 약속. 다 쓰면 cancel로 정리한다. */
  waitRequest(requestId: string): { promise: Promise<void>; cancel(): void };
  notifyRequests(requestIds: Iterable<string>): void;
  /** 세션에 inbox 대기자를 붙인다. 이미 있던 대기자는 gone으로 끝낸다. */
  attachInbox(sessionId: string, machineId: string, waiterId: string): InboxWaiter;
  /** 전달을 시도하는 동안 대기자를 목록에서 꺼낸다(한 번에 한 곳만 전달하도록). */
  takeInbox(sessionId: string): InboxWaiter | null;
  /** 꺼냈던 대기자를 되돌린다. 그 사이 새 대기자가 붙었으면 gone으로 끝낸다. */
  returnInbox(waiter: InboxWaiter): void;
  /** 조건에 맞는 inbox 대기자를 gone으로 끝낸다(스위치 꺼짐·기기 해제·세션 종료). */
  dropInbox(where: { sessionId: string } | { machineId: string }): void;
  /** 한 세션의 전달 시도를 줄 세운다. 이미 진행 중이면 "한 번 더"만 표시하고 false. */
  beginDelivery(sessionId: string): boolean;
  /** 전달 시도 한 번을 마친다. retryIfAsked이고 그 사이 "한 번 더" 표시가 있었으면 true(다시 돈다). */
  endDelivery(sessionId: string, retryIfAsked: boolean): boolean;
  /** 지금 붙어 있는 대기자 수(테스트·점검용). */
  size(): { requests: number; inbox: number };
};

export function createReplyHub(): ReplyHub {
  const requests = new Map<string, Set<() => void>>();
  const inbox = new Map<string, InboxWaiter>();
  /** 전달 시도 중인 세션 → 그 사이 "한 번 더" 요청이 있었는가 */
  const delivering = new Map<string, boolean>();

  function makeWaiter(sessionId: string, machineId: string, waiterId: string): InboxWaiter {
    let settled = false;
    let done!: (r: ReplyInboxResponse) => void;
    const promise = new Promise<ReplyInboxResponse>((resolve) => { done = resolve; });
    const waiter: InboxWaiter = {
      sessionId, machineId, waiterId, promise,
      get settled() { return settled; },
      resolve(result) {
        if (!waiter.claim()) return false;
        done(result);
        return true;
      },
      claim() {
        if (settled) return false;
        settled = true;
        if (inbox.get(sessionId) === waiter) inbox.delete(sessionId);
        return true;
      },
      finish(result) {
        done(result);
      },
    };
    return waiter;
  }

  return {
    waitRequest(requestId) {
      let wake!: () => void;
      const promise = new Promise<void>((resolve) => { wake = resolve; });
      let set = requests.get(requestId);
      if (!set) requests.set(requestId, (set = new Set()));
      set.add(wake);
      return {
        promise,
        cancel() {
          const cur = requests.get(requestId);
          if (!cur) return;
          cur.delete(wake);
          if (cur.size === 0) requests.delete(requestId);
        },
      };
    },
    notifyRequests(requestIds) {
      for (const id of requestIds) {
        const set = requests.get(id);
        if (!set) continue;
        requests.delete(id);
        for (const wake of set) wake();
      }
    },
    attachInbox(sessionId, machineId, waiterId) {
      inbox.get(sessionId)?.resolve({ status: 'gone' });
      const waiter = makeWaiter(sessionId, machineId, waiterId);
      inbox.set(sessionId, waiter);
      return waiter;
    },
    takeInbox(sessionId) {
      const waiter = inbox.get(sessionId);
      if (!waiter) return null;
      inbox.delete(sessionId);
      return waiter;
    },
    returnInbox(waiter) {
      if (waiter.settled) return;
      if (inbox.has(waiter.sessionId)) waiter.resolve({ status: 'gone' });
      else inbox.set(waiter.sessionId, waiter);
    },
    dropInbox(where) {
      for (const waiter of [...inbox.values()]) {
        const hit = 'sessionId' in where ? waiter.sessionId === where.sessionId : waiter.machineId === where.machineId;
        if (hit) waiter.resolve({ status: 'gone' });
      }
    },
    beginDelivery(sessionId) {
      if (delivering.has(sessionId)) {
        delivering.set(sessionId, true);
        return false;
      }
      delivering.set(sessionId, false);
      return true;
    },
    endDelivery(sessionId, retryIfAsked) {
      if (retryIfAsked && delivering.get(sessionId)) {
        delivering.set(sessionId, false);
        return true;
      }
      delivering.delete(sessionId);
      return false;
    },
    size() {
      let n = 0;
      for (const set of requests.values()) n += set.size;
      return { requests: n, inbox: inbox.size };
    },
  };
}
