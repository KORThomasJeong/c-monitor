// 서버·웹·플러그인이 함께 따르는 API 계약.
// 플러그인은 의존성이 없어 이 파일을 import하지 않고, 같은 모양의 JSON을 만든다.
import { z } from 'zod';

export const API = {
  ingest: '/api/ingest',
  deviceStart: '/api/device/start',
  devicePoll: '/api/device/poll',
  deviceApprove: '/api/device/approve',
  me: '/api/me',
  sessions: '/api/sessions',
  stream: '/api/stream',
  settings: '/api/settings',
  adminUsers: '/api/admin/users',
} as const;

export const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'Stop', 'StopFailure', 'SubagentStop', 'SessionEnd',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

export const SESSION_STATUSES = ['run', 'wait', 'done', 'lost', 'end', 'limit'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** 한 줄 최대 크기(바이트). 넘으면 플러그인이 잘라서 truncated 표시. */
export const MAX_LINE_BYTES = 64 * 1024;
/** 한 번 전송 최대 크기(바이트). 넘으면 서버가 413. */
export const MAX_BATCH_BYTES = 512 * 1024;

const iso = z.string().datetime({ offset: true });
const pct = z.number().min(0).max(100);

export const MachineInfoSchema = z.object({
  name: z.string().min(1).max(100),
  os: z.string().max(100),
  pluginVersion: z.string().max(40),
});
export type MachineInfo = z.infer<typeof MachineInfoSchema>;

export const HookEventSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  event: z.enum(HOOK_EVENTS),
  at: iso,
  account: z.string().max(320).nullable(),
  cwd: z.string().max(2000),
  branch: z.string().max(300).nullable(),
  model: z.string().max(200).nullable(),
  data: z.record(z.unknown()),
});
export type HookEvent = z.infer<typeof HookEventSchema>;

export const TranscriptLineSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  at: iso,
  text: z.string(),
  toolName: z.string().max(200).optional(),
  toolInput: z.unknown().optional(),
  truncated: z.boolean().optional(),
  masked: z.number().int().min(0).optional(),
});
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

export const TranscriptChunkSchema = z.object({
  sessionId: z.string().min(1).max(200),
  /** 이 묶음 첫 줄의 순번(0부터). 줄 i의 순번은 seq + i. */
  seq: z.number().int().min(0),
  lines: z.array(TranscriptLineSchema),
});
export type TranscriptChunk = z.infer<typeof TranscriptChunkSchema>;

export const LimitSnapshotSchema = z.object({
  account: z.string().min(1).max(320),
  fiveHourPct: pct,
  /** epoch 초 */
  fiveHourResetsAt: z.number().int().nullable(),
  sevenDayPct: pct,
  sevenDayResetsAt: z.number().int().nullable(),
  at: iso,
});
export type LimitSnapshot = z.infer<typeof LimitSnapshotSchema>;

export const IngestBatchSchema = z.object({
  machine: MachineInfoSchema,
  events: z.array(HookEventSchema).max(500),
  transcript: z.array(TranscriptChunkSchema).max(100),
  limits: LimitSnapshotSchema.optional(),
});
export type IngestBatch = z.infer<typeof IngestBatchSchema>;
export type IngestResponse = { accepted: number };

// ── 기기 연결 ─────────────────────────────────────────────
export type DeviceStartRequest = { machineName: string; os: string; pluginVersion: string };
export type DeviceStartResponse = {
  deviceCode: string;
  /** 사람이 확인하는 코드, 형식 XXXX-XXXX */
  userCode: string;
  verifyUrl: string;
  interval: number;
  expiresIn: number;
};
export type DevicePollResponse = { token: string; machineId: string; machineName: string };

// ── 조회 응답 ─────────────────────────────────────────────
export type UserView = {
  id: string; email: string; name: string | null;
  role: 'admin' | 'user'; status: 'pending' | 'active' | 'suspended';
};
export type MeResponse = { user: UserView; pendingCount?: number };

export type MachineView = {
  id: string; name: string; os: string; pluginVersion: string;
  lastSeenAt: string | null; online: boolean; remoteReply: boolean;
};

export type SessionView = {
  id: string;
  machineId: string;
  account: string | null;
  cwd: string;
  /** 카드 제목: cwd의 마지막 폴더 이름 */
  name: string;
  branch: string | null;
  model: string | null;
  status: SessionStatus;
  /** wait 상태를 사용자가 열어 봤는지 */
  seen: boolean;
  startedAt: string;
  lastEventAt: string;
  endedAt: string | null;
  /** 카드에 보일 마지막 활동 한 줄 */
  activity: { label: string; text: string } | null;
  /** 남이 공유해 준 세션이면 소유자 이메일 */
  sharedBy?: string;
};

export type AccountView = {
  email: string; alias: string | null; hidden: boolean;
  fiveHourPct: number | null; fiveHourResetsAt: number | null;
  sevenDayPct: number | null; sevenDayResetsAt: number | null;
  at: string | null;
  /** 최근 7일 주간 사용률(하루 1점) */
  history: { at: string; sevenDayPct: number }[];
};

export type LogLine = TranscriptLine & { seq: number };
export type DashboardSnapshot = { sessions: SessionView[]; machines: MachineView[]; accounts: AccountView[] };
export type LogResponse = { lines: LogLine[] };

export type SettingsView = { lostMinutes: number; endHours: number; keepChatDays: number; keepUsageDays: number };

// ── 실시간 스트림(SSE) ────────────────────────────────────
export type StreamMessage =
  | ({ type: 'snapshot' } & DashboardSnapshot)
  | { type: 'session'; session: SessionView }
  | { type: 'log'; sessionId: string; lines: LogLine[] }
  | { type: 'limits'; account: AccountView }
  | { type: 'machine'; machine: MachineView };
