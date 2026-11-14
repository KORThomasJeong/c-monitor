// 기기 연결: start(플러그인) → approve 또는 deny(웹, 로그인 필요) → poll(플러그인이 토큰 수령).
// 연결 해제: disconnect(플러그인이 자기 토큰으로 자기 기기를 폐기).
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { DevicePollResponse, DeviceStartResponse } from '@c-monitor/shared';
import { machineGuard, requireMachine, requireUser, userGuard } from '../auth/guard';
import { loadMachineViews } from '../query/views';
import type { Deps, Env } from '../types';
import { fail, readBody } from '../util';
import { revokeMachine } from './revoke';
import { hashToken, newToken, newUserCode, normalizeUserCode } from './token';

const EXPIRES_SECONDS = 600;
const POLL_INTERVAL = 3;

const StartSchema = z.object({
  machineName: z.string().trim().min(1).max(100),
  os: z.string().max(100).default(''),
  pluginVersion: z.string().max(40).default(''),
});
const PollSchema = z.object({ deviceCode: z.string().min(1).max(200) });
const ApproveSchema = z.object({ userCode: z.string().min(1).max(40) });

type PollResult =
  | { kind: 'gone' }
  | { kind: 'pending' }
  | { kind: 'ok'; userId: string; body: DevicePollResponse };

export function deviceRoutes(deps: Deps): Hono<Env> {
  const { sql, config } = deps;
  const app = new Hono<Env>();
  /** 아직 답(승인·거부)을 기다리는 요청만 고르는 조건. */
  const open = (now: Date) =>
    sql`approved_user_id IS NULL AND machine_id IS NULL AND denied_at IS NULL AND expires_at > ${now}`;

  app.post('/api/device/start', async (c) => {
    const body = await readBody(c, StartSchema);
    const deviceCode = newToken();
    const expires = new Date(deps.now().getTime() + EXPIRES_SECONDS * 1000);
    // user_code가 겹치면(매우 드묾) 다시 뽑는다.
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = newUserCode();
      const rows = await sql`
        INSERT INTO device_requests (device_code, user_code, machine_name, os, plugin_version, expires_at)
        VALUES (${hashToken(deviceCode)}, ${userCode}, ${body.machineName}, ${body.os}, ${body.pluginVersion}, ${expires})
        ON CONFLICT (user_code) DO NOTHING RETURNING user_code`;
      if (rows.length > 0) {
        const res: DeviceStartResponse = {
          deviceCode,
          userCode,
          verifyUrl: `${config.publicUrl}/connect?code=${userCode}`,
          interval: POLL_INTERVAL,
          expiresIn: EXPIRES_SECONDS,
        };
        return c.json(res);
      }
    }
    throw fail(503, 'try_again');
  });

  app.post('/api/device/poll', async (c) => {
    const { deviceCode } = await readBody(c, PollSchema);
    const now = deps.now();
    const result: PollResult = await sql.begin(async (tx): Promise<PollResult> => {
      const [r] = await tx<{
        machine_name: string; os: string; plugin_version: string;
        expires_at: Date; approved_user_id: string | null; machine_id: string | null; denied_at: Date | null;
      }[]>`
        SELECT machine_name, os, plugin_version, expires_at, approved_user_id, machine_id, denied_at
        FROM device_requests WHERE device_code = ${hashToken(deviceCode)} FOR UPDATE`;
      if (!r || r.machine_id || r.denied_at || r.expires_at <= now) return { kind: 'gone' };
      if (!r.approved_user_id) return { kind: 'pending' };
      // 승인됨: 이때 토큰을 만들어 한 번만 돌려준다. DB에는 해시만 남는다.
      const token = newToken();
      const machineId = randomUUID();
      await tx`
        INSERT INTO machines (id, user_id, name, os, plugin_version, token_hash, last_seen_at, created_at)
        VALUES (${machineId}, ${r.approved_user_id}, ${r.machine_name}, ${r.os}, ${r.plugin_version},
                ${hashToken(token)}, ${now}, ${now})`;
      await tx`UPDATE device_requests SET machine_id = ${machineId} WHERE device_code = ${hashToken(deviceCode)}`;
      return { kind: 'ok', userId: r.approved_user_id, body: { token, machineId, machineName: r.machine_name } };
    });

    if (result.kind === 'gone') return c.json({ error: 'expired' }, 410);
    if (result.kind === 'pending') return c.json({ status: 'pending' }, 202);
    const [machine] = await loadMachineViews(sql, result.userId, now, { id: result.body.machineId });
    if (machine) deps.bus.publish(result.userId, { type: 'machine', machine });
    return c.json(result.body);
  });

  // 확인 화면에서 "어떤 컴퓨터를 연결하는지" 보여 주기 위한 조회.
  app.get('/api/device/lookup', userGuard(deps, 'active'), async (c) => {
    const code = normalizeUserCode(c.req.query('code') ?? '');
    if (!code) throw fail(404, 'not_found');
    const [r] = await sql<{ machine_name: string; os: string }[]>`
      SELECT machine_name, os FROM device_requests
      WHERE user_code = ${code} AND ${open(deps.now())}`;
    if (!r) throw fail(404, 'not_found');
    return c.json({ userCode: code, machineName: r.machine_name, os: r.os });
  });

  app.post('/api/device/approve', userGuard(deps, 'active'), async (c) => {
    const body = await readBody(c, ApproveSchema);
    const code = normalizeUserCode(body.userCode);
    if (!code) throw fail(404, 'not_found');
    const [r] = await sql<{ machine_name: string }[]>`
      UPDATE device_requests SET approved_user_id = ${requireUser(c).id}
      WHERE user_code = ${code} AND ${open(deps.now())}
      RETURNING machine_name`;
    if (!r) throw fail(404, 'not_found');
    return c.json({ ok: true, machineName: r.machine_name });
  });

  // 확인 화면의 "거부". 이후 poll은 410을 받아 터미널이 바로 끝난다.
  app.post('/api/device/deny', userGuard(deps, 'active'), async (c) => {
    const body = await readBody(c, ApproveSchema);
    const code = normalizeUserCode(body.userCode);
    if (!code) throw fail(404, 'not_found');
    const now = deps.now();
    const rows = await sql`
      UPDATE device_requests SET denied_at = ${now}
      WHERE user_code = ${code} AND ${open(now)}
      RETURNING user_code`;
    if (rows.length === 0) throw fail(404, 'not_found');
    return c.json({ ok: true });
  });

  // 터미널의 --disconnect. 정지된 사용자의 기기도 스스로 연결을 끊을 수는 있다.
  app.post('/api/device/disconnect', machineGuard(deps, { allowInactiveUser: true }), async (c) => {
    const machine = requireMachine(c);
    if (!(await revokeMachine(deps, machine.userId, machine.id))) throw fail(401, 'unauthorized');
    return c.json({ ok: true });
  });

  return app;
}
