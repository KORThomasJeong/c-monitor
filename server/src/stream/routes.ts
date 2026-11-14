// GET /api/stream — SSE. 접속 즉시 snapshot, 이후 그 사용자의 변경만, 주기적으로 `: ping`.
//   ?user=<id>  관리자만: 그 사용자의 대시보드를 본다(원격 답장 정보는 비워서 보낸다 — 읽기 전용).
// 사람 지정으로 공유받은 세션은 소유자 채널을 함께 구독해 그 세션의 session·log·reply·removed만 받는다
// (sharedBy를 붙이고 원격 답장·원격 제어 주소는 비운다).
import { Hono } from 'hono';
import type { StreamMessage } from '@c-monitor/shared';
import { requireUser, userGuard } from '../auth/guard';
import { loadSharedWith, loadSnapshot, stripReply, toSharedView } from '../query/views';
import type { Deps, Env } from '../types';
import { fail } from '../util';
import { openSse } from './sse';

type Shared = Map<string, { ownerId: string; ownerEmail: string }>;

export function streamRoutes(deps: Deps): Hono<Env> {
  const { sql } = deps;
  const app = new Hono<Env>();

  app.get('/api/stream', userGuard(deps, 'active'), async (c) => {
    const viewer = requireUser(c);
    const target = c.req.query('user') || viewer.id;
    const asAdmin = target !== viewer.id;
    if (asAdmin) {
      if (viewer.role !== 'admin') throw fail(403, 'forbidden');
      const [u] = await sql`SELECT 1 FROM users WHERE id = ${target}`;
      if (!u) throw fail(404, 'not_found');
    }
    /** 소유자가 아닌 관리자에게는 원격 답장 정보를 비워 보낸다. */
    const forViewer = (msg: StreamMessage): StreamMessage => {
      if (!asAdmin) return msg;
      if (msg.type === 'session') return { ...msg, session: msg.session.sharedBy ? msg.session : stripReply(msg.session) };
      if (msg.type === 'snapshot') return { ...msg, sessions: msg.sessions.map((s) => (s.sharedBy ? s : stripReply(s))) };
      return msg;
    };

    // 보는 사람이 그대로 승인된 사용자인지(관리자 열람이면 여전히 관리자인지) 핑마다 확인한다.
    const recheck = async () => {
      const [u] = await sql<{ status: string; role: string; withdrawn: boolean }[]>`
        SELECT status, role, delete_at IS NOT NULL AS withdrawn FROM users WHERE id = ${viewer.id}`;
      return !!u && u.status === 'active' && !u.withdrawn && (!asAdmin || u.role === 'admin');
    };

    return openSse(c, deps, async (io) => {
      let shared: Shared = new Map();
      const ownerSubs = new Map<string, () => void>();

      const onOwner = async (ownerId: string, msg: StreamMessage) => {
        switch (msg.type) {
          case 'session': {
            const info = shared.get(msg.session.id);
            if (info?.ownerId === ownerId) await io.send({ type: 'session', session: toSharedView(msg.session, info.ownerEmail) });
            return;
          }
          case 'log':
          case 'reply':
            if (shared.get(msg.sessionId)?.ownerId === ownerId) await io.send(msg);
            return;
          case 'removed': {
            const ids = msg.sessionIds.filter((id) => shared.get(id)?.ownerId === ownerId);
            for (const id of ids) shared.delete(id);
            if (ids.length > 0) await io.send({ type: 'removed', sessionIds: ids });
            return;
          }
          default:
            return; // 소유자의 컴퓨터·계정·스냅샷은 받은 사람에게 보내지 않는다
        }
      };

      /** 공유받은 세션 목록을 다시 읽고, 소유자 채널 구독을 맞춘다. */
      const refreshShares = async () => {
        shared = await loadSharedWith(sql, target, deps.now());
        const owners = new Set([...shared.values()].map((v) => v.ownerId));
        for (const [ownerId, unsub] of ownerSubs) {
          if (!owners.has(ownerId)) {
            unsub();
            ownerSubs.delete(ownerId);
          }
        }
        for (const ownerId of owners) {
          if (ownerSubs.has(ownerId) || ownerId === target) continue;
          ownerSubs.set(ownerId, deps.bus.subscribe(ownerId, (msg) => io.serial(() => onOwner(ownerId, msg))));
        }
      };

      // 스냅샷을 읽는 동안 생긴 변경을 놓치지 않도록 먼저 구독한다(처리는 스냅샷을 보낸 뒤 차례로).
      io.serial(async () => {
        await refreshShares();
        await io.send({ type: 'snapshot', ...(await loadSnapshot(sql, target, deps.now(), { viewerId: viewer.id })) });
      });
      const unsubscribe = deps.bus.subscribe(target, (msg) => io.serial(async () => {
        // 대시보드를 통째로 다시 보낼 때는 공유받은 세션이 바뀌었을 수 있다(공유 추가·취소, 소유자 탈퇴).
        if (msg.type === 'snapshot') await refreshShares();
        await io.send(forViewer(msg));
      }));
      try {
        await io.ended;
      } finally {
        unsubscribe();
        for (const unsub of ownerSubs.values()) unsub();
      }
    }, recheck);
  });

  return app;
}
