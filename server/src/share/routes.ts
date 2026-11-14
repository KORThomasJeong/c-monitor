// 공유(3차). 계약: shared/src/contract.ts "공유".
//   로그인(소유자)  POST·GET /api/sessions/:id/shares · DELETE /api/shares/:id
//   로그인 없이     GET /api/public/s/:token · /log · /stream (토큰으로만, 보기만)
// 공개 링크로는 그 세션의 상태·대화만 내보낸다 — 컴퓨터 정보·다른 세션·답장·원격 제어 주소·소유자 이메일·세션 id는 절대 내보내지 않는다.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  LOG_PAGE_MAX, LOG_PAGE_SIZE, ShareCreateSchema,
  type PublicSessionView, type PublicStreamMessage, type SessionView, type ShareView,
} from '@c-monitor/shared';
import { republishSnapshots } from '../account/users';
import { requireUser, userGuard } from '../auth/guard';
import { hashToken, newToken } from '../device/token';
import { readCursor, readLimit } from '../query/routes';
import { loadLogPage, shareValid, toSessionView, type SessionRow } from '../query/views';
import { openSse } from '../stream/sse';
import type { Deps, Env, Q } from '../types';
import { fail, readBody } from '../util';

const HOUR_MS = 60 * 60_000;
const EXPIRES_MS = { '1h': HOUR_MS, '1d': 24 * HOUR_MS, '7d': 7 * 24 * HOUR_MS, never: null } as const;
/** newToken()이 만드는 모양(32바이트 base64url = 43글자). 다른 모양은 DB를 보지 않고 404. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

type ShareRow = { id: string; target_email: string | null; token: string | null; expires_at: Date | null; created_at: Date };

const toShareView = (r: ShareRow, url: string | null = null): ShareView => ({
  id: r.id,
  kind: r.token ? 'link' : 'user',
  url,
  email: r.target_email,
  expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
  createdAt: r.created_at.toISOString(),
});

/** 세션 뷰 → 공개 링크용 뷰(허용한 필드만 골라 담는다). */
export function toPublicView(s: SessionView, expiresAt: Date | null): PublicSessionView {
  return {
    name: s.name, status: s.status, branch: s.branch, model: s.model,
    startedAt: s.startedAt, lastEventAt: s.lastEventAt, endedAt: s.endedAt,
    activity: s.activity, contextPct: s.contextPct, costUsd: s.costUsd,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}

type PublicShare = { sessionId: string; ownerId: string; expiresAt: Date | null };

/** 공개 링크 토큰 → 지금 쓸 수 있는 공유. 만료·취소(행 없음)·세션 삭제(CASCADE)·소유자 탈퇴·정지면 null. */
async function resolvePublic(sql: Q, token: string, now: Date): Promise<PublicShare | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [r] = await sql<{ session_id: string; owner_id: string; expires_at: Date | null }[]>`
    SELECT sh.session_id, sh.owner_id, sh.expires_at
    FROM shares sh JOIN users o ON o.id = sh.owner_id JOIN sessions s ON s.id = sh.session_id
    WHERE sh.token = ${hashToken(token)} AND sh.target_user_id IS NULL AND ${shareValid(sql, now)}`;
  return r ? { sessionId: r.session_id, ownerId: r.owner_id, expiresAt: r.expires_at } : null;
}

async function loadPublicView(sql: Q, share: PublicShare): Promise<PublicSessionView | null> {
  const [row] = await sql<SessionRow[]>`SELECT * FROM sessions WHERE id = ${share.sessionId}`;
  return row ? toPublicView(toSessionView(row), share.expiresAt) : null;
}

export function shareRoutes(deps: Deps): Hono<Env> {
  const { sql, config } = deps;
  const app = new Hono<Env>();
  const active = userGuard(deps, 'active');

  /** 소유자 본인의 세션인가. 남의 것은 관리자·공유받은 사람이라도 없는 것처럼 404. */
  async function ownSession(sessionId: string, userId: string): Promise<void> {
    const rows = await sql`SELECT 1 FROM sessions WHERE id = ${sessionId} AND user_id = ${userId}`;
    if (rows.length === 0) throw fail(404, 'not_found');
  }

  app.post('/api/sessions/:id/shares', active, async (c) => {
    const user = requireUser(c);
    const sessionId = c.req.param('id');
    const body = await readBody(c, ShareCreateSchema);
    await ownSession(sessionId, user.id);
    const now = deps.now();

    if (body.kind === 'link') {
      const token = newToken();
      const ms = EXPIRES_MS[body.expiresIn];
      const expiresAt = ms === null ? null : new Date(now.getTime() + ms);
      const [row] = await sql<ShareRow[]>`
        INSERT INTO shares (id, session_id, owner_id, token, expires_at, created_at)
        VALUES (${randomUUID()}, ${sessionId}, ${user.id}, ${hashToken(token)}, ${expiresAt}, ${now})
        RETURNING id, NULL::text AS target_email, token, expires_at, created_at`;
      // 토큰 원문은 이때 한 번만 내려준다(DB에는 해시만).
      return c.json(toShareView(row!, `${config.publicUrl}/s/${token}`));
    }

    if (body.email === user.email) throw fail(409, 'self');
    const [target] = await sql<{ id: string; email: string }[]>`
      SELECT id, email FROM users WHERE email = ${body.email} AND delete_at IS NULL`;
    if (!target) throw fail(409, 'user_not_found');
    await sql`
      INSERT INTO shares (id, session_id, owner_id, target_user_id, created_at)
      VALUES (${randomUUID()}, ${sessionId}, ${user.id}, ${target.id}, ${now})
      ON CONFLICT (session_id, target_user_id) WHERE target_user_id IS NOT NULL DO NOTHING`;
    const [row] = await sql<ShareRow[]>`
      SELECT sh.id, ${target.email}::text AS target_email, sh.token, sh.expires_at, sh.created_at
      FROM shares sh WHERE sh.session_id = ${sessionId} AND sh.target_user_id = ${target.id}`;
    // 받은 사람의 대시보드에 "공유받은 세션"으로 바로 나타나게 한다.
    await republishSnapshots(deps, [target.id]);
    return c.json(toShareView(row!));
  });

  app.get('/api/sessions/:id/shares', active, async (c) => {
    const user = requireUser(c);
    const sessionId = c.req.param('id');
    await ownSession(sessionId, user.id);
    const rows = await sql<ShareRow[]>`
      SELECT sh.id, t.email AS target_email, sh.token, sh.expires_at, sh.created_at
      FROM shares sh LEFT JOIN users t ON t.id = sh.target_user_id
      WHERE sh.session_id = ${sessionId} AND sh.owner_id = ${user.id}
        AND (sh.expires_at IS NULL OR sh.expires_at > ${deps.now()})
      ORDER BY sh.created_at, sh.id`;
    return c.json({ shares: rows.map((r) => toShareView(r)) });
  });

  // 공유 취소(만든 사람만). 링크는 바로 404가 되고, 열려 있던 공개 스트림도 다음 핑에서 끝난다.
  app.delete('/api/shares/:id', active, async (c) => {
    const user = requireUser(c);
    const [row] = await sql<{ target_user_id: string | null }[]>`
      DELETE FROM shares WHERE id = ${c.req.param('id')} AND owner_id = ${user.id} RETURNING target_user_id`;
    if (!row) throw fail(404, 'not_found');
    if (row.target_user_id) await republishSnapshots(deps, [row.target_user_id]);
    return c.json({ ok: true });
  });

  // ── 로그인 없이: 공개 링크 ───────────────────────────────

  app.get('/api/public/s/:token', async (c) => {
    const share = await resolvePublic(sql, c.req.param('token'), deps.now());
    const view = share && (await loadPublicView(sql, share));
    if (!view) throw fail(404, 'not_found');
    c.header('Cache-Control', 'no-store');
    return c.json(view);
  });

  app.get('/api/public/s/:token/log', async (c) => {
    const share = await resolvePublic(sql, c.req.param('token'), deps.now());
    if (!share) throw fail(404, 'not_found');
    const cursor = readCursor(c.req.query());
    const limit = readLimit(c.req.query('limit'), LOG_PAGE_SIZE, LOG_PAGE_MAX);
    c.header('Cache-Control', 'no-store');
    return c.json(await loadLogPage(sql, share.sessionId, cursor, limit));
  });

  app.get('/api/public/s/:token/stream', async (c) => {
    const token = c.req.param('token');
    const share = await resolvePublic(sql, token, deps.now());
    const first = share && (await loadPublicView(sql, share));
    if (!share || !first) throw fail(404, 'not_found');
    const recheck = async () => (await resolvePublic(sql, token, deps.now())) !== null;

    return openSse(c, deps, async (io) => {
      const send = (msg: PublicStreamMessage) => io.send(msg);
      io.serial(() => send({ type: 'public', session: first }));
      // 그 세션의 상태와 새 대화 줄만 넘긴다. 세션이 지워지면 끝낸다.
      const unsubscribe = deps.bus.subscribe(share.ownerId, (msg) => io.serial(async () => {
        if (msg.type === 'session' && msg.session.id === share.sessionId) {
          await send({ type: 'public', session: toPublicView(msg.session, share.expiresAt) });
        } else if (msg.type === 'log' && msg.sessionId === share.sessionId) {
          await send({ type: 'log', lines: msg.lines });
        } else if (msg.type === 'removed' && msg.sessionIds.includes(share.sessionId)) {
          io.end();
        }
      }));
      try {
        await io.ended;
      } finally {
        unsubscribe();
      }
    }, recheck);
  });

  return app;
}
