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

// ── 대화 조회(페이지 단위) ────────────────────────────────
// GET /api/sessions/:id/log
//   (쿼리 없음)        가장 최근 limit줄
//   ?before=<seq>      seq보다 앞선 줄 중 가장 가까운 limit줄 (이전 대화 더 보기)
//   ?after=<seq>       seq보다 뒤 줄을 앞에서부터 limit줄 (재연결 뒤 빠진 줄 채우기)
//   ?around=<seq>      seq가 가운데 오도록 앞뒤로 합쳐 limit줄 (검색 결과로 이동)
//   ?limit=<n>         기본 LOG_PAGE_SIZE, 최대 LOG_PAGE_MAX
// before·after·around는 한 번에 하나만. 응답의 lines는 항상 seq 오름차순.
export const LOG_PAGE_SIZE = 100;
export const LOG_PAGE_MAX = 500;
export type LogResponse = {
  lines: LogLine[];
  /** 이 세션에 저장된 전체 줄 수 */
  total: number;
  /** lines의 첫 줄보다 앞선 줄이 더 있다 */
  hasMoreBefore: boolean;
  /** lines의 마지막 줄보다 뒤 줄이 더 있다 */
  hasMoreAfter: boolean;
};

// ── 대화 검색 ─────────────────────────────────────────────
// GET /api/sessions/:id/search?q=<글자>&limit=<n>
// 대소문자를 가리지 않고 본문(text)과 도구 이름에서 찾는다. 최신 줄부터.
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_LIMIT = 50;
export type LogSearchHit = {
  seq: number;
  role: TranscriptLine['role'];
  at: string;
  toolName?: string;
  /** 찾은 글자 주변을 잘라 낸 한 줄(최대 160자, 줄바꿈은 공백으로) */
  snippet: string;
};
export type LogSearchResponse = {
  hits: LogSearchHit[];
  /** 찾은 전체 개수(hits보다 많을 수 있다) */
  total: number;
};

export type SettingsView = { lostMinutes: number; endHours: number; keepChatDays: number; keepUsageDays: number };

// ── 실시간 스트림(SSE) ────────────────────────────────────
export type StreamMessage =
  | ({ type: 'snapshot' } & DashboardSnapshot)
  | { type: 'session'; session: SessionView }
  | { type: 'log'; sessionId: string; lines: LogLine[] }
  | { type: 'limits'; account: AccountView }
  | { type: 'machine'; machine: MachineView }
  /** 세션이 지워졌다(사용자가 삭제). 화면에서 카드와 불러 둔 대화를 없앤다. */
  | { type: 'removed'; sessionIds: string[] };

// ── 세션 삭제 ─────────────────────────────────────────────
// DELETE /api/sessions/:id → { ok: true }
// 소유자만. 종료(end)·연락 끊김(lost) 세션만 지울 수 있고, 그 밖의 상태면 409 { error: 'session_active' }.
// 세션과 그 대화 줄을 모두 지우고 'removed' 메시지를 낸다.
export const DELETABLE_STATUSES: readonly SessionStatus[] = ['end', 'lost'];
