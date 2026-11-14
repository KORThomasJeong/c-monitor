// 테스트 도우미: 개발 DB에 임시 스키마를 만들어 쓰고, 끝나면 지운다. public 스키마는 건드리지 않는다.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { HookEvent, HookEventName, IngestBatch, StreamMessage, TranscriptLine } from '@c-monitor/shared';
import { createApp } from '../src/app';
import { migrate } from '../src/db/index';
import { createTelegramHub } from '../src/notify/hub';
import { createPushHub, type PushSender } from '../src/notify/push';
import { createReplyHub } from '../src/reply/hub';
import { createBus } from '../src/stream/bus';
import type { Config, Deps, GoogleClient } from '../src/types';

/** 저장소 루트 .env.dev를 직접 읽는다(dotenv 없이). 환경변수가 있으면 그쪽이 우선. */
export function readDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const file = fileURLToPath(new URL('../../.env.dev', import.meta.url));
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() === 'DATABASE_URL') {
      return line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new Error('.env.dev에 DATABASE_URL이 없습니다');
}

export type TestDb = { sql: postgres.Sql; schema: string; drop(): Promise<void> };

export async function makeTestDb(): Promise<TestDb> {
  const url = readDatabaseUrl();
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const sql = postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: schema } });
  await migrate(sql);
  return {
    sql,
    schema,
    async drop() {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.end();
    },
  };
}

export const ADMIN = 'admin@example.com';

export type ReqOpts = { cookie?: string; token?: string; body?: unknown; raw?: string };

export function makeHarness(db: TestDb, overrides: Partial<Deps> = {}, configOverrides: Partial<Config> = {}) {
  const clock = { now: new Date('2026-11-14T03:00:00.000Z') };
  const published: { userId: string; msg: StreamMessage }[] = [];
  const inner = createBus();
  const bus: Deps['bus'] = {
    publish(userId, msg) {
      published.push({ userId, msg });
      inner.publish(userId, msg);
    },
    subscribe: inner.subscribe,
  };
  // 가짜 구글: 인가 코드가 곧 이메일이다.
  const google: GoogleClient = {
    authUrl: (state) => `https://google.test/auth?state=${encodeURIComponent(state)}`,
    exchange: async (code) => {
      if (code === 'bad') throw new Error('구글 교환 실패');
      return { email: code, name: `이름 ${code}` };
    },
  };
  const config: Config = {
    publicUrl: 'https://cs.test',
    adminEmails: [ADMIN],
    sessionSecret: 'test-secret',
    googleClientId: 'id',
    googleClientSecret: 'secret',
    ...configOverrides,
  };
  const deps: Deps = {
    sql: db.sql, config, bus, google, now: () => new Date(clock.now), reply: createReplyHub(),
    // 텔레그램은 기본으로 꺼 둔다. 실제 네트워크로 나가지 않도록 클라이언트 만들기는 막아 둔다.
    telegram: createTelegramHub(),
    telegramClient: () => { throw new Error('테스트에서는 가짜 텔레그램 클라이언트를 넣어야 합니다'); },
    // 웹 푸시도 실제 푸시 서비스로 나가지 않도록 보내기를 막아 둔다(구독이 있을 때만 불린다).
    push: createPushHub({
      sender: async () => { throw new Error('테스트에서는 가짜 웹 푸시 sender를 넣어야 합니다'); },
      waitGraceMs: 0,
    }),
    ...overrides,
  };
  const app = createApp(deps);

  async function req(method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.raw !== undefined) body = opts.raw;
    else if (opts.body !== undefined) body = JSON.stringify(opts.body);
    if (body !== undefined) headers['content-type'] = 'application/json';
    return app.request(path, { method, headers, body });
  }

  function cookieFrom(res: Response, name: string): string | null {
    for (const line of res.headers.getSetCookie()) {
      if (line.startsWith(`${name}=`)) return line.split(';')[0]!;
    }
    return null;
  }

  /** 구글 로그인 흐름을 끝까지 돌려 로그인 쿠키(`cm_session=...`)를 돌려준다. */
  async function login(email: string): Promise<string> {
    const start = await req('GET', '/auth/google');
    const oauth = cookieFrom(start, 'cm_oauth')!;
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cb = await req(
      'GET',
      `/auth/google/callback?code=${encodeURIComponent(email)}&state=${encodeURIComponent(state)}`,
      { cookie: oauth },
    );
    const cookie = cookieFrom(cb, 'cm_session');
    if (!cookie) throw new Error(`로그인 실패: ${cb.status}`);
    return cookie;
  }

  async function userId(email: string): Promise<string> {
    const [row] = await db.sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
    return row!.id;
  }

  /** 승인된 사용자를 만든다(DB에서 바로 active로). */
  async function activeUser(email: string): Promise<{ cookie: string; id: string }> {
    const cookie = await login(email);
    const id = await userId(email);
    await db.sql`UPDATE users SET status = 'active' WHERE id = ${id}`;
    return { cookie, id };
  }

  /** 기기 연결 흐름(start → approve → poll)으로 토큰을 받는다. */
  async function connect(cookie: string, machineName = 'pc-1'): Promise<{ token: string; machineId: string }> {
    const startRes = await req('POST', '/api/device/start', { body: { machineName, os: 'win32', pluginVersion: '0.1.0' } });
    const start = (await startRes.json()) as { deviceCode: string; userCode: string };
    const ap = await req('POST', '/api/device/approve', { cookie, body: { userCode: start.userCode } });
    if (ap.status !== 200) throw new Error(`승인 실패: ${ap.status}`);
    const poll = await req('POST', '/api/device/poll', { body: { deviceCode: start.deviceCode } });
    return (await poll.json()) as { token: string; machineId: string };
  }

  function ev(
    sessionId: string,
    event: HookEventName,
    data: Record<string, unknown> = {},
    extra: Partial<HookEvent> = {},
  ): HookEvent {
    return {
      id: randomUUID(), sessionId, event, at: clock.now.toISOString(),
      account: null, cwd: 'C:\\work\\proj-a', branch: 'main', model: 'opus', data, ...extra,
    };
  }

  function line(text: string, extra: Partial<TranscriptLine> = {}): TranscriptLine {
    return { role: 'assistant', at: clock.now.toISOString(), text, ...extra };
  }

  function batch(events: HookEvent[], extra: Partial<IngestBatch> = {}): IngestBatch {
    return { machine: { name: 'pc-1', os: 'win32', pluginVersion: '0.1.0' }, events, transcript: [], ...extra };
  }

  async function ingest(token: string, b: IngestBatch): Promise<Response> {
    return req('POST', '/api/ingest', { token, body: b });
  }

  return {
    app, bus, deps, clock, published, req, login, userId, activeUser, connect, ev, line, batch, ingest, cookieFrom,
    advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); },
  };
}

/** 가짜 웹 푸시 sender: 보낸 것을 적어 두고, endpoint별로 돌려줄 상태 코드를 정할 수 있다(기본 201). */
export function fakePush() {
  const sent: { endpoint: string; payload: { title: string; body: string; url: string; tag: string } }[] = [];
  const statusOf = new Map<string, number>();
  const sender: PushSender = async (sub, payload) => {
    const code = statusOf.get(sub.endpoint) ?? 201;
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { statusCode: code };
  };
  return {
    sender, sent, statusOf,
    /** 그 endpoint로 간 것(지금까지 쌓인 것을 비우고 돌려준다). */
    take(endpoint?: string) {
      const out = sent.filter((m) => endpoint === undefined || m.endpoint === endpoint);
      sent.splice(0, sent.length, ...sent.filter((m) => !out.includes(m)));
      return out;
    },
    clear() { sent.length = 0; },
  };
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** SSE 응답을 블록(빈 줄로 구분) 단위로 읽는다. */
export function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  async function next(): Promise<string> {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        return block;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error('스트림이 끝났습니다');
      buf += decoder.decode(value, { stream: true });
    }
  }
  return {
    next,
    /** 다음 data 메시지(핑은 건너뜀)를 JSON으로. */
    async nextMessage(): Promise<StreamMessage> {
      for (;;) {
        const block = await next();
        if (block.startsWith('data: ')) return JSON.parse(block.slice(6)) as StreamMessage;
      }
    },
    close: () => reader.cancel(),
  };
}
