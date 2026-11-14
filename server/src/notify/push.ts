// 웹 푸시(VAPID): 키 만들기·보관, 보내기 큐, 구독자에게 보내기, 알림 내용(평문).
// 보내는 함수(PushSender)는 Deps.push로 주입한다 — 테스트에서는 가짜를 넣어 실제 푸시 서비스로 아무것도 나가지 않게 한다.
import webpush from 'web-push';
import type { Deps, Q } from '../types';
import { head } from '../util';
import { defaultSleep } from './hub';
import { decryptSecret, encryptSecret } from './secret';

export type VapidKeys = { publicKey: string; privateKey: string };
export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };
/** 서비스 워커가 받는 알림 내용. url은 누르면 열 주소(같은 사이트 경로). */
export type PushPayload = { title: string; body: string; url: string; tag: string };

/** 구독 하나에 보낸다. → 푸시 서비스의 HTTP 상태(404·410이면 구독이 없어졌다). 네트워크 오류는 던진다. */
export type PushSender = (sub: PushTarget, payload: string, vapid: VapidKeys & { subject: string }) => Promise<{ statusCode: number }>;

/** 실제 web-push 라이브러리로 보내는 sender(운영용). */
export const webPushSender: PushSender = async (sub, payload, vapid) => {
  try {
    const res = await webpush.sendNotification(sub, payload, {
      vapidDetails: vapid, TTL: 60 * 60, timeout: 10_000,
    });
    return { statusCode: res.statusCode };
  } catch (err) {
    if (err instanceof webpush.WebPushError) return { statusCode: err.statusCode };
    throw err;
  }
};

export type PushHub = {
  readonly sender: PushSender;
  /** 일반 "답을 기다림" 알림을 늦추는 시간(ms) — 텔레그램과 같은 이유(곧 뒤따르는 승인·질문 알림만 보내려고). */
  readonly waitGraceMs: number;
  /** 불러 둔 VAPID 키(처음 쓸 때 DB에서 읽거나 만든다). */
  keys: VapidKeys | null;
  /** 보내기 큐에 일을 넣는다. 요청 처리 흐름을 막지 않고, 실패는 로그만 남긴다. */
  enqueue(name: string, task: () => Promise<void>): void;
  later(ms: number, name: string, task: () => Promise<void>): void;
  /** 같은 키는 windowMs 안에 한 번만 → 보내도 되면 true. */
  throttle(key: string, now: Date): boolean;
  /** 큐와 예약된 일이 모두 끝날 때까지 기다린다(테스트·종료용). */
  idle(): Promise<void>;
};

export type PushHubOptions = { sender?: PushSender; waitGraceMs?: number; throttleMs?: number };

const THROTTLE_MS = 30_000;

export function createPushHub(opts: PushHubOptions = {}): PushHub {
  const throttleMs = opts.throttleMs ?? THROTTLE_MS;
  let chain: Promise<void> = Promise.resolve();
  const inflight = new Set<Promise<unknown>>();
  const lastSent = new Map<string, number>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  };
  const hub: PushHub = {
    sender: opts.sender ?? webPushSender,
    waitGraceMs: opts.waitGraceMs ?? 4_000,
    keys: null,
    enqueue(name, task) {
      const next = chain.then(async () => {
        try {
          await task();
        } catch (err) {
          console.error(`[push] ${name} 실패:`, err instanceof Error ? err.message : err);
        }
      });
      chain = next;
      track(next);
    },
    later(ms, name, task) {
      if (ms <= 0) return hub.enqueue(name, task);
      track(defaultSleep(ms).then(() => hub.enqueue(name, task)));
    },
    throttle(key, now) {
      const t = now.getTime();
      const prev = lastSent.get(key);
      if (prev !== undefined && t - prev < throttleMs && t >= prev) return false;
      lastSent.set(key, t);
      if (lastSent.size > 5_000) {
        for (const [k, v] of lastSent) if (t - v >= throttleMs) lastSent.delete(k);
      }
      return true;
    },
    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
  return hub;
}

type KeyDeps = Pick<Deps, 'sql' | 'config' | 'now' | 'push'>;

/**
 * VAPID 키. DB에 없으면 만들어 넣는다(비밀 키는 봇 토큰과 같은 방식으로 암호화).
 * 저장된 비밀 키를 풀지 못하면(SESSION_SECRET이 바뀜) 새로 만들고 옛 구독을 모두 지운다(옛 공개 키에 묶여 쓸 수 없다).
 */
export async function vapidKeys(deps: KeyDeps): Promise<VapidKeys> {
  if (deps.push.keys) return deps.push.keys;
  const secret = deps.config.sessionSecret;
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await deps.sql<{ public_key: string; private_key_enc: string }[]>`
      SELECT public_key, private_key_enc FROM push_keys WHERE id = 1`;
    if (row) {
      const privateKey = decryptSecret(row.private_key_enc, secret, 'push');
      if (privateKey) return (deps.push.keys = { publicKey: row.public_key, privateKey });
      console.error('[push] 저장된 VAPID 키를 풀지 못해 새로 만듭니다(SESSION_SECRET이 바뀌었나요?). 브라우저마다 다시 구독해야 합니다.');
      const k = webpush.generateVAPIDKeys();
      const swapped = await deps.sql`
        UPDATE push_keys SET public_key = ${k.publicKey}, private_key_enc = ${encryptSecret(k.privateKey, secret, 'push')},
          created_at = ${deps.now()}
        WHERE id = 1 AND private_key_enc = ${row.private_key_enc} RETURNING id`;
      if (swapped.length > 0) {
        await deps.sql`DELETE FROM push_subscriptions`;
        return (deps.push.keys = k);
      }
      continue; // 다른 요청이 먼저 바꿨다 — 다시 읽는다
    }
    const k = webpush.generateVAPIDKeys();
    await deps.sql`
      INSERT INTO push_keys (id, public_key, private_key_enc, created_at)
      VALUES (1, ${k.publicKey}, ${encryptSecret(k.privateKey, secret, 'push')}, ${deps.now()})
      ON CONFLICT (id) DO NOTHING`;
    // 동시에 만든 쪽이 이겼을 수 있으니 저장된 것을 다시 읽는다.
  }
  throw new Error('VAPID 키를 준비하지 못했습니다');
}

/** VAPID subject: https 주소면 서비스 주소, 아니면(개발) 자리표시 mailto. */
function subjectOf(publicUrl: string): string {
  return publicUrl.startsWith('https://') ? publicUrl : 'mailto:noreply@example.invalid';
}

/** 구독이 하나라도 있는, 알림을 받을 수 있는(승인됨·탈퇴 안 함) 사용자인가. */
export async function hasPushTargets(sql: Q, userId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id
    WHERE ps.user_id = ${userId} AND u.status = 'active' AND u.delete_at IS NULL LIMIT 1`;
  return rows.length > 0;
}

/** 이 키로 아직 보내지 않았으면 적고 true(한 번만 보낼 알림용: 승인·질문 요청, 한도 창). */
export async function pushOnce(sql: Q, userId: string, key: string, now: Date): Promise<boolean> {
  const rows = await sql`
    INSERT INTO push_sent (user_id, key, created_at) VALUES (${userId}, ${key}, ${now})
    ON CONFLICT DO NOTHING RETURNING key`;
  return rows.length > 0;
}

/** 구독 하나에 보낸다. 없어진 구독(404·410)은 지운다. → 'ok' | 'gone' | 'failed' */
export async function sendToSubscription(deps: KeyDeps, userId: string, sub: PushTarget, payload: PushPayload): Promise<'ok' | 'gone' | 'failed'> {
  const keys = await vapidKeys(deps);
  try {
    const { statusCode } = await deps.push.sender(sub, JSON.stringify(payload), { ...keys, subject: subjectOf(deps.config.publicUrl) });
    if (statusCode === 404 || statusCode === 410) {
      await deps.sql`DELETE FROM push_subscriptions WHERE endpoint = ${sub.endpoint} AND user_id = ${userId}`;
      return 'gone';
    }
    if (statusCode >= 200 && statusCode < 300) return 'ok';
    console.error(`[push] 보내기 실패(${statusCode})`);
    return 'failed';
  } catch (err) {
    console.error('[push] 보내기 실패:', err instanceof Error ? err.message : err);
    return 'failed';
  }
}

/** 그 사용자의 모든 구독(브라우저)에 보낸다. 승인됨·탈퇴 안 함 사용자만. → 보낸 구독 수 */
export async function sendPush(deps: KeyDeps, userId: string, payload: PushPayload): Promise<number> {
  const subs = await deps.sql<{ endpoint: string; p256dh: string; auth: string }[]>`
    SELECT ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id
    WHERE ps.user_id = ${userId} AND u.status = 'active' AND u.delete_at IS NULL
    ORDER BY ps.created_at`;
  let ok = 0;
  for (const s of subs) {
    const r = await sendToSubscription(deps, userId, { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
    if (r === 'ok') ok++;
  }
  return ok;
}

// ── 알림 내용(평문) ─────────────────────────────────────

const BODY_MAX = 200;
const sessionPath = (sessionId: string) => `/?session=${encodeURIComponent(sessionId)}`;
const titleOf = (emoji: string, name: string, machine: string) => `${emoji} ${name || '세션'} · ${machine}`;
const clip = (text: string) => head(text.replace(/\s+/g, ' ').trim(), BODY_MAX);

export type PushHead = { sessionId: string; name: string; machine: string };

export const pushText = {
  request(h: PushHead, r: { kind: 'permission' | 'question'; toolName: string; summary: string }): PushPayload {
    return {
      title: titleOf(r.kind === 'permission' ? '🙋' : '❓', h.name, h.machine),
      body: r.kind === 'permission'
        ? clip(`승인을 기다립니다 — ${r.toolName}${r.summary ? `: ${r.summary}` : ''}`)
        : clip(`질문에 답을 기다립니다${r.summary ? `: ${r.summary}` : ''}`),
      url: sessionPath(h.sessionId), tag: `wait:${h.sessionId}`,
    };
  },
  wait(h: PushHead, text: string): PushPayload {
    return { title: titleOf('🙋', h.name, h.machine), body: clip(text ? `답을 기다립니다: ${text}` : '답을 기다립니다'), url: sessionPath(h.sessionId), tag: `wait:${h.sessionId}` };
  },
  done(h: PushHead, text: string): PushPayload {
    return { title: titleOf('✅', h.name, h.machine), body: clip(text ? `작업이 끝났습니다: ${text}` : '작업이 끝났습니다'), url: sessionPath(h.sessionId), tag: `done:${h.sessionId}` };
  },
  lost(h: PushHead, text: string): PushPayload {
    return { title: titleOf('⚠️', h.name, h.machine), body: clip(text ? `연락이 끊겼습니다: ${text}` : '연락이 끊겼습니다 — 한동안 소식이 없습니다'), url: sessionPath(h.sessionId), tag: `lost:${h.sessionId}` };
  },
  limit(a: { account: string; window: 'five' | 'seven'; pct: number; limitPct: number }): PushPayload {
    return {
      title: `📊 ${a.account}`,
      body: `${a.window === 'five' ? '5시간' : '주간'} 한도 ${Math.round(a.pct)}% 사용 (알림 기준 ${a.limitPct}%)`,
      url: '/', tag: `limit:${a.account}:${a.window}`,
    };
  },
  signup(u: { email: string; name: string | null }): PushPayload {
    return { title: '👤 가입 신청', body: `${u.name ? `${u.name} (${u.email})` : u.email} — 관리자 화면에서 승인해 주세요.`, url: '/admin', tag: 'signup' };
  },
  trim(t: { lines: number; quotaMb: number }): PushPayload {
    return {
      title: '💾 저장 용량 한도',
      body: `저장 용량 한도(${t.quotaMb}MB)를 넘어 오래된 대화 ${t.lines}줄을 지웠습니다.`,
      url: '/', tag: 'trim',
    };
  },
  test(): PushPayload {
    return { title: '🔔 c-monitor', body: '시험 알림입니다. 앞으로 알림이 이 브라우저로 옵니다.', url: '/', tag: 'test' };
  },
};
