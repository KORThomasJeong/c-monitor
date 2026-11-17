import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_BATCH_BYTES, type DashboardSnapshot, type LogResponse, type SessionView } from '@c-monitor/shared';
import { ADMIN, makeHarness, makeTestDb, type TestDb } from './helpers';

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let a: { cookie: string; id: string; token: string; machineId: string };
let b: { cookie: string; id: string; token: string; machineId: string };

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db);
  const ua = await h.activeUser('a@example.com');
  const ub = await h.activeUser('b@example.com');
  a = { ...ua, ...(await h.connect(ua.cookie, 'pc-a')) };
  b = { ...ub, ...(await h.connect(ub.cookie, 'pc-b')) };
});
afterAll(async () => { await db.drop(); });

async function sessionsOf(cookie: string, q = ''): Promise<SessionView[]> {
  const res = await h.req('GET', `/api/sessions${q}`, { cookie });
  return ((await res.json()) as DashboardSnapshot).sessions;
}
async function one(cookie: string, claudeId: string, machineId: string): Promise<SessionView> {
  const s = (await sessionsOf(cookie)).find((x) => x.id === `${machineId}:${claudeId}`);
  if (!s) throw new Error('세션 없음');
  return s;
}

describe('수집', () => {
  it('세션이 없으면 만들고 nextStatus로 상태를 갱신한다', async () => {
    const res = await h.ingest(a.token, h.batch([h.ev('s1', 'SessionStart'), h.ev('s1', 'UserPromptSubmit', { prompt: '안녕하세요' })]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2 });
    const s = await one(a.cookie, 's1', a.machineId);
    expect(s).toMatchObject({
      id: `${a.machineId}:s1`, machineId: a.machineId, status: 'run', cwd: 'C:\\work\\proj-a',
      name: 'proj-a', branch: 'main', model: 'opus', seen: true, endedAt: null,
      activity: { label: '질문', text: '안녕하세요' },
    });

    await h.ingest(a.token, h.batch([h.ev('s1', 'Stop', { last_assistant_message: '끝났습니다' })]));
    expect(await one(a.cookie, 's1', a.machineId)).toMatchObject({ status: 'done', activity: { label: '완료', text: '끝났습니다' } });
  });

  it('같은 이벤트 id는 한 번만 반영한다(멱등)', async () => {
    const first = h.ev('s2', 'UserPromptSubmit', { prompt: 'p' });
    const stop = h.ev('s2', 'Stop', {});
    await h.ingest(a.token, h.batch([first, stop]));
    const again = await h.ingest(a.token, h.batch([first]));
    expect(await again.json()).toEqual({ accepted: 0 });
    expect((await one(a.cookie, 's2', a.machineId)).status).toBe('done');
    // 한 묶음 안에 같은 id가 두 번 있어도 한 번만
    const dup = h.ev('s2', 'UserPromptSubmit', { prompt: 'q' });
    expect(await (await h.ingest(a.token, h.batch([dup, dup]))).json()).toEqual({ accepted: 1 });
  });

  it('wait이 되면 seen=false, seen 호출로 true', async () => {
    await h.ingest(a.token, h.batch([h.ev('s3', 'UserPromptSubmit', { prompt: 'x' })]));
    await h.ingest(a.token, h.batch([h.ev('s3', 'Notification', { notification_type: 'permission_prompt', message: '권한이 필요합니다' })]));
    expect(await one(a.cookie, 's3', a.machineId)).toMatchObject({ status: 'wait', seen: false, activity: { label: '알림', text: '권한이 필요합니다' } });

    const id = encodeURIComponent(`${a.machineId}:s3`);
    expect((await h.req('POST', `/api/sessions/${id}/seen`, { cookie: a.cookie })).status).toBe(200);
    expect((await one(a.cookie, 's3', a.machineId)).seen).toBe(true);

    // AskUserQuestion도 wait
    await h.ingest(a.token, h.batch([h.ev('s3', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} })]));
    expect(await one(a.cookie, 's3', a.machineId)).toMatchObject({ status: 'wait', seen: false });
  });

  it('끝나면 seen=false(초록 깜박임), seen 호출(알람 끄기)로 true, 다음 작업 뒤 다시 끝나면 또 false', async () => {
    // 막 열린 세션(입력 대기)은 깜박이지 않는다
    await h.ingest(a.token, h.batch([h.ev('s3d', 'SessionStart', {})]));
    expect(await one(a.cookie, 's3d', a.machineId)).toMatchObject({ status: 'done', seen: true });

    await h.ingest(a.token, h.batch([h.ev('s3d', 'UserPromptSubmit', { prompt: 'x' }), h.ev('s3d', 'Stop', {})]));
    expect(await one(a.cookie, 's3d', a.machineId)).toMatchObject({ status: 'done', seen: false });

    const id = encodeURIComponent(`${a.machineId}:s3d`);
    expect((await h.req('POST', `/api/sessions/${id}/seen`, { cookie: a.cookie })).status).toBe(200);
    expect((await one(a.cookie, 's3d', a.machineId)).seen).toBe(true);

    // 끝난 상태에서 또 오는 Stop은 알람을 다시 켜지 않는다
    await h.ingest(a.token, h.batch([h.ev('s3d', 'Stop', {})]));
    expect((await one(a.cookie, 's3d', a.machineId)).seen).toBe(true);

    await h.ingest(a.token, h.batch([h.ev('s3d', 'UserPromptSubmit', { prompt: 'y' }), h.ev('s3d', 'Stop', {})]));
    expect(await one(a.cookie, 's3d', a.machineId)).toMatchObject({ status: 'done', seen: false });
  });

  it('활동 한 줄을 이벤트별로 만든다', async () => {
    const act = async (...evs: Parameters<typeof h.ev>[]) => {
      await h.ingest(a.token, h.batch(evs.map((e) => h.ev(...e))));
      return (await one(a.cookie, 's4', a.machineId)).activity;
    };
    expect(await act(['s4', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test', description: '테스트' } }]))
      .toEqual({ label: 'Bash', text: 'npm test' });
    expect(await act(['s4', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a/b.ts' } }]))
      .toEqual({ label: 'Read', text: '/a/b.ts' });
    // 활동을 만들지 않는 이벤트는 앞의 것을 유지
    expect(await act(['s4', 'PostToolUse', { tool_name: 'Read' }])).toEqual({ label: 'Read', text: '/a/b.ts' });
    expect((await act(['s4', 'UserPromptSubmit', { prompt: '가'.repeat(500) }]))!.text).toHaveLength(200);
    expect(await act(['s4', 'StopFailure', { error: 'rate_limit' }])).toEqual({ label: '실패', text: 'rate_limit' });
    expect((await one(a.cookie, 's4', a.machineId)).status).toBe('limit');
    expect(await act(['s4', 'SessionEnd', { reason: 'logout' }])).toEqual({ label: '종료', text: 'logout' });
    const s = await one(a.cookie, 's4', a.machineId);
    expect(s.status).toBe('end');
    expect(s.endedAt).not.toBeNull();
  });

  it('transcript는 (session, seq) 중복을 무시한다', async () => {
    await h.ingest(a.token, h.batch([h.ev('s5', 'UserPromptSubmit', { prompt: 'x' })], {
      transcript: [{ sessionId: 's5', seq: 0, lines: [h.line('0번', { role: 'user' }), h.line('1번')] }],
    }));
    h.published.length = 0;
    await h.ingest(a.token, h.batch([], {
      transcript: [{ sessionId: 's5', seq: 1, lines: [
        h.line('1번(다시)'),
        h.line('2번', { role: 'tool', toolName: 'Bash', toolInput: { command: 'ls' }, truncated: true, masked: 2 }),
      ] }],
    }));
    const id = encodeURIComponent(`${a.machineId}:s5`);
    const log = (await (await h.req('GET', `/api/sessions/${id}/log`, { cookie: a.cookie })).json()) as LogResponse;
    expect(log.lines.map((l) => [l.seq, l.text])).toEqual([[0, '0번'], [1, '1번'], [2, '2번']]);
    expect(log.lines[2]).toMatchObject({ role: 'tool', toolName: 'Bash', toolInput: { command: 'ls' }, truncated: true, masked: 2 });

    // 새로 들어간 줄만 스트림으로 나간다
    const logs = h.published.filter((p) => p.msg.type === 'log');
    expect(logs).toHaveLength(1);
    const msg = logs[0]!.msg;
    expect(msg.type === 'log' && msg.lines.map((l) => l.seq)).toEqual([2]);
    expect(msg.type === 'log' && msg.sessionId).toBe(`${a.machineId}:s5`);

    const after = (await (await h.req('GET', `/api/sessions/${id}/log?after=1`, { cookie: a.cookie })).json()) as LogResponse;
    expect(after.lines.map((l) => l.seq)).toEqual([2]);
  });

  it('본문이 512KB를 넘으면 413', async () => {
    const big = h.batch([], {
      transcript: [{ sessionId: 's6', seq: 0, lines: Array.from({ length: 10 }, () => h.line('x'.repeat(60_000))) }],
    });
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_BATCH_BYTES);
    const res = await h.ingest(a.token, big);
    expect(res.status).toBe(413);
    expect((await sessionsOf(a.cookie)).some((s) => s.id.endsWith(':s6'))).toBe(false);

    // 한도 바로 아래는 받는다
    const ok = h.batch([], {
      transcript: [{ sessionId: 's6', seq: 0, lines: Array.from({ length: 8 }, () => h.line('x'.repeat(60_000))) }],
    });
    expect(JSON.stringify(ok).length).toBeLessThan(MAX_BATCH_BYTES);
    expect((await h.ingest(a.token, ok)).status).toBe(200);
  });

  it('스키마에 맞지 않으면 400', async () => {
    expect((await h.req('POST', '/api/ingest', { token: a.token, raw: '{not json' })).status).toBe(400);
    expect((await h.req('POST', '/api/ingest', { token: a.token, body: { events: [] } })).status).toBe(400);
    const bad = h.batch([{ ...h.ev('s7', 'Stop'), id: 'not-a-uuid' }]);
    expect((await h.ingest(a.token, bad)).status).toBe(400);
  });

  it('기기 A가 보낸 것은 A 소유자에게만 publish되고 B에게는 보이지 않는다', async () => {
    h.published.length = 0;
    await h.ingest(a.token, h.batch([h.ev('same-id', 'UserPromptSubmit', { prompt: 'A의 비밀' }, { account: 'a-claude@example.com' })], {
      transcript: [{ sessionId: 'same-id', seq: 0, lines: [h.line('A의 대화')] }],
      limits: { account: 'a-claude@example.com', fiveHourPct: 10, fiveHourResetsAt: 1, sevenDayPct: 20, sevenDayResetsAt: 2, at: h.clock.now.toISOString() },
    }));
    expect(h.published.length).toBeGreaterThanOrEqual(3);
    expect(new Set(h.published.map((p) => p.userId))).toEqual(new Set([a.id]));
    expect(new Set(h.published.map((p) => p.msg.type))).toEqual(new Set(['session', 'log', 'limits']));

    // B가 같은 클로드 세션 id로 보내도 서로 다른 세션이다
    await h.ingest(b.token, h.batch([h.ev('same-id', 'Stop', { last_assistant_message: 'B의 것' })]));
    const sa = await one(a.cookie, 'same-id', a.machineId);
    const sb = await one(b.cookie, 'same-id', b.machineId);
    expect(sa.status).toBe('run');
    expect(sb.status).toBe('done');
    expect((await sessionsOf(b.cookie)).every((s) => s.machineId === b.machineId)).toBe(true);
    const snapB = (await (await h.req('GET', '/api/sessions', { cookie: b.cookie })).json()) as DashboardSnapshot;
    expect(snapB.accounts.map((x) => x.email)).not.toContain('a-claude@example.com');
    expect(snapB.machines.map((m) => m.id)).toEqual([b.machineId]);
  });

  it('limits가 오면 계정과 한도를 기록하고, 이벤트의 account는 세션에 반영된다', async () => {
    const at = h.clock.now.toISOString();
    await h.ingest(a.token, h.batch([h.ev('s8', 'UserPromptSubmit', { prompt: 'x' }, { account: 'work@example.com' })], {
      limits: { account: 'work@example.com', fiveHourPct: 42.5, fiveHourResetsAt: 1_800_000_000, sevenDayPct: 61, sevenDayResetsAt: null, at },
    }));
    expect((await one(a.cookie, 's8', a.machineId)).account).toBe('work@example.com');
    const snap = (await (await h.req('GET', '/api/sessions', { cookie: a.cookie })).json()) as DashboardSnapshot;
    const acc = snap.accounts.find((x) => x.email === 'work@example.com')!;
    expect(acc).toMatchObject({
      alias: null, hidden: false, fiveHourPct: 42.5, fiveHourResetsAt: 1_800_000_000, sevenDayPct: 61, sevenDayResetsAt: null,
    });
    expect(new Date(acc.at!).toISOString()).toBe(at);
    expect(acc.history).toHaveLength(1);
    expect(acc.history[0]!.sevenDayPct).toBe(61);

    // cswap으로 계정이 바뀌면 세션의 계정도 바뀐다
    await h.ingest(a.token, h.batch([h.ev('s8', 'PostToolUse', {}, { account: 'home@example.com' })]));
    expect((await one(a.cookie, 's8', a.machineId)).account).toBe('home@example.com');
    const snap2 = (await (await h.req('GET', '/api/sessions', { cookie: a.cookie })).json()) as DashboardSnapshot;
    expect(snap2.accounts.find((x) => x.email === 'home@example.com')).toMatchObject({ fiveHourPct: null, at: null, history: [] });
  });

  it('기기 정보(마지막 접속·버전)를 갱신한다', async () => {
    await h.ingest(a.token, { ...h.batch([]), machine: { name: 'pc-a', os: 'linux', pluginVersion: '0.2.0' } });
    const snap = (await (await h.req('GET', '/api/sessions', { cookie: a.cookie })).json()) as DashboardSnapshot;
    expect(snap.machines[0]).toMatchObject({ id: a.machineId, name: 'pc-a', os: 'linux', pluginVersion: '0.2.0', online: true, remoteReply: true });
  });

  it('DB가 받지 못하는 글자(NUL, 잘린 이모지)가 있어도 저장된다', async () => {
    const half = '😀'.slice(0, 1); // 64KB에서 잘려 반쪽만 남은 서로게이트
    const res = await h.ingest(a.token, h.batch([h.ev('s9', 'UserPromptSubmit', { prompt: `a\u0000b${half}` })], {
      transcript: [{ sessionId: 's9', seq: 0, lines: [h.line(`x\u0000y${half}`, { toolInput: { command: `c\u0000d${half}` } })] }],
    }));
    expect(res.status).toBe(200);
    expect((await one(a.cookie, 's9', a.machineId)).activity).toEqual({ label: '질문', text: 'ab�' });
    const id = encodeURIComponent(`${a.machineId}:s9`);
    const log = (await (await h.req('GET', `/api/sessions/${id}/log`, { cookie: a.cookie })).json()) as LogResponse;
    expect(log.lines[0]).toMatchObject({ text: 'xy�', toolInput: { command: 'cd�' } });
  });

  it('관리자 계정으로도 수집 격리는 같다', async () => {
    const admin = await h.login(ADMIN);
    const mine = (await (await h.req('GET', '/api/sessions', { cookie: admin })).json()) as DashboardSnapshot;
    expect(mine.sessions).toEqual([]);
  });
});
