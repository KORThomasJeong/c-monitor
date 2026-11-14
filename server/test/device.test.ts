import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DevicePollResponse, DeviceStartResponse } from '@c-monitor/shared';
import { ADMIN, MIN, makeHarness, makeTestDb, type TestDb } from './helpers';

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
beforeAll(async () => { db = await makeTestDb(); h = makeHarness(db); });
afterAll(async () => { await db.drop(); });

async function start(name = 'pc-1'): Promise<DeviceStartResponse> {
  const res = await h.req('POST', '/api/device/start', { body: { machineName: name, os: 'win32', pluginVersion: '0.1.0' } });
  expect(res.status).toBe(200);
  return (await res.json()) as DeviceStartResponse;
}

describe('기기 연결', () => {
  it('start는 XXXX-XXXX 코드와 확인 주소를 준다', async () => {
    const s = await start();
    expect(s.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(s.verifyUrl).toBe(`https://cs.test/connect?code=${s.userCode}`);
    expect(s.interval).toBe(3);
    expect(s.expiresIn).toBe(600);
    expect(s.deviceCode.length).toBeGreaterThanOrEqual(32);
  });

  it('잘못된 본문은 400', async () => {
    expect((await h.req('POST', '/api/device/start', { body: { os: 'x' } })).status).toBe(400);
    expect((await h.req('POST', '/api/device/start', { raw: '{' })).status).toBe(400);
  });

  it('start → approve → poll이 토큰을 한 번만 돌려주고, 토큰은 해시로만 저장된다', async () => {
    const admin = await h.login(ADMIN);
    const s = await start('내 노트북');

    expect((await h.req('POST', '/api/device/poll', { body: { deviceCode: s.deviceCode } })).status).toBe(202);

    // 확인 화면용 조회
    const look = await h.req('GET', `/api/device/lookup?code=${s.userCode}`, { cookie: admin });
    expect(await look.json()).toMatchObject({ machineName: '내 노트북', os: 'win32' });

    // 소문자·하이픈 없이 넣어도 승인된다
    const ap = await h.req('POST', '/api/device/approve', {
      cookie: admin, body: { userCode: s.userCode.replace('-', '').toLowerCase() },
    });
    expect(ap.status).toBe(200);

    const poll = await h.req('POST', '/api/device/poll', { body: { deviceCode: s.deviceCode } });
    expect(poll.status).toBe(200);
    const got = (await poll.json()) as DevicePollResponse;
    expect(got.token.length).toBeGreaterThanOrEqual(43);
    expect(got.machineName).toBe('내 노트북');

    expect((await h.req('POST', '/api/device/poll', { body: { deviceCode: s.deviceCode } })).status).toBe(410);

    const [m] = await db.sql<{ token_hash: string; user_id: string; name: string }[]>`
      SELECT token_hash, user_id, name FROM machines WHERE id = ${got.machineId}`;
    expect(m!.token_hash).toBe(createHash('sha256').update(got.token).digest('hex'));
    expect(m!.user_id).toBe(await h.userId(ADMIN));
    // 토큰 원문은 DB 어디에도 없다
    const dump = JSON.stringify([
      await db.sql`SELECT * FROM machines`,
      await db.sql`SELECT * FROM device_requests`,
    ]);
    expect(dump).not.toContain(got.token);
    expect(dump).not.toContain(s.deviceCode);

    // 같은 코드로 다시 승인할 수 없다
    expect((await h.req('POST', '/api/device/approve', { cookie: admin, body: { userCode: s.userCode } })).status).toBe(404);
  });

  it('승인은 로그인한 active 사용자만 할 수 있다', async () => {
    const s = await start();
    expect((await h.req('POST', '/api/device/approve', { body: { userCode: s.userCode } })).status).toBe(401);
    const pending = await h.login('pending-dev@example.com');
    expect((await h.req('POST', '/api/device/approve', { cookie: pending, body: { userCode: s.userCode } })).status).toBe(403);
    expect((await h.req('POST', '/api/device/poll', { body: { deviceCode: s.deviceCode } })).status).toBe(202);
  });

  it('10분이 지나면 만료된다', async () => {
    const admin = await h.login(ADMIN);
    const s = await start();
    h.advance(11 * MIN);
    expect((await h.req('POST', '/api/device/approve', { cookie: admin, body: { userCode: s.userCode } })).status).toBe(404);
    expect((await h.req('POST', '/api/device/poll', { body: { deviceCode: s.deviceCode } })).status).toBe(410);
    expect((await h.req('POST', '/api/device/poll', { body: { deviceCode: 'unknown' } })).status).toBe(410);
  });

  it('없는 토큰·폐기된 토큰은 401', async () => {
    const admin = await h.login(ADMIN);
    const { token, machineId } = await h.connect(admin, 'pc-revoke');
    expect((await h.ingest(token, h.batch([]))).status).toBe(200);
    expect((await h.ingest('bogus-token', h.batch([]))).status).toBe(401);
    expect((await h.req('POST', '/api/ingest', { body: h.batch([]) })).status).toBe(401);

    expect((await h.req('DELETE', `/api/machines/${machineId}`, { cookie: admin })).status).toBe(200);
    expect((await h.ingest(token, h.batch([]))).status).toBe(401);
  });

  it('남의 기기는 폐기할 수 없다', async () => {
    const admin = await h.login(ADMIN);
    const { token, machineId } = await h.connect(admin, 'pc-keep');
    const other = await h.activeUser('other-dev@example.com');
    expect((await h.req('DELETE', `/api/machines/${machineId}`, { cookie: other.cookie })).status).toBe(404);
    expect((await h.ingest(token, h.batch([]))).status).toBe(200);
  });

  it('정지된 사용자의 기기는 전송이 막힌다', async () => {
    const u = await h.activeUser('susp-dev@example.com');
    const { token } = await h.connect(u.cookie, 'pc-susp');
    await db.sql`UPDATE users SET status = 'suspended' WHERE id = ${u.id}`;
    expect((await h.ingest(token, h.batch([]))).status).toBe(403);
  });
});
