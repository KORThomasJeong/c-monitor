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
  /** 그 세션의 공식 원격 제어 화면 주소(세션에서 /remote-control 을 켰을 때만). 0.2.0 이전 플러그인은 보내지 않는다. */
  remoteUrl: z.string().max(300).regex(/^https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]+$/).nullable().optional(),
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
  /** 웹에서 답할 수 있는, 지금 기다리는 승인·질문(없으면 null). 소유자에게만 채운다. */
  pending: PendingView | null;
  /** 이 세션에 웹에서 글을 보낼 수 있는가(소유자 본인, 컴퓨터의 원격 답장 켜짐, 플러그인 REPLY_MIN_PLUGIN 이상, 종료·끊김 아님). */
  canReply: boolean;
  /** 보냈지만 아직 세션에 전달되지 않은 글 수 */
  queuedMessages: number;
  /** 공식 원격 제어 화면 주소(없으면 null) */
  remoteUrl: string | null;
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

// ══ 원격 답장(2차) ════════════════════════════════════════
// 웹에서 승인·선택지·글로 세션에 답한다. 터미널의 창은 그대로 떠 있고, 먼저 답한 쪽이 이긴다.
//
// 플러그인 쪽(기기 토큰):
//   승인·질문  PermissionRequest 훅(bin/ask.mjs, 동기)이 POST /api/reply/ask 로 등록하고,
//              POST /api/reply/wait 를 답이 올 때까지 되풀이한다(서버는 한 번에 REPLY_POLL_SECONDS 까지 붙잡는다).
//   글         Stop·SessionStart 훅(bin/inbox.mjs, async + asyncRewake)이 POST /api/reply/inbox 를 되풀이하다가
//              글이 오면 stderr 로 내보내고 종료 코드 2로 끝나 멈춘 세션을 깨운다.
// 웹 쪽(로그인):
//   POST /api/sessions/:id/reply   답 보내기
//   PATCH /api/machines/:id        { remoteReply } 컴퓨터별 스위치

/** 원격 답장을 지원하는 가장 낮은 플러그인 버전 */
export const REPLY_MIN_PLUGIN = '0.2.0';
/** 서버가 wait·inbox 요청 하나를 붙잡고 있는 최대 시간(초). 프록시 제한시간(60초)보다 짧게. */
export const REPLY_POLL_SECONDS = 25;
/** 플러그인이 이 시간(초) 넘게 다시 묻지 않으면 그 승인·질문은 없어진 것으로 본다. */
export const REPLY_STALE_SECONDS = 90;
/** 웹에서 보내는 글·거부 사유·직접 쓴 답의 최대 길이 */
export const MESSAGE_MAX_CHARS = 4000;

export const ReplyQuestionSchema = z.object({
  question: z.string().min(1).max(2000),
  header: z.string().max(200).optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(z.object({ label: z.string().min(1).max(500), description: z.string().max(2000).optional() })).max(10),
});
export type ReplyQuestion = z.infer<typeof ReplyQuestionSchema>;

/** POST /api/reply/ask — 승인(permission) 또는 선택지 질문(question) 등록 */
export const ReplyAskSchema = z.object({
  sessionId: z.string().min(1).max(200),
  kind: z.enum(['permission', 'question']),
  toolName: z.string().min(1).max(200),
  /** 비밀을 가리고 줄인 도구 입력(훅 이벤트의 data.tool_input 과 같은 규칙) */
  toolInput: z.unknown(),
  /** 서브에이전트가 낸 요청이면 그 id */
  agentId: z.string().max(200).nullable(),
  /** "이 세션 동안 허용"이 하는 일을 설명한 한 줄. null 이면 그 선택을 쓸 수 없다. */
  sessionAllow: z.string().max(500).nullable(),
  /** kind 가 question 일 때 AskUserQuestion 의 질문들 */
  questions: z.array(ReplyQuestionSchema).min(1).max(4).optional(),
  at: iso,
});
export type ReplyAsk = z.infer<typeof ReplyAskSchema>;
/** disabled: 이 컴퓨터의 원격 답장이 꺼져 있다 — 훅은 아무것도 하지 않고 끝낸다. */
export type ReplyAskResponse = { requestId: string } | { disabled: true };

export const ReplyAnswerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('permission'),
    /** allow_session = 허용하고 이 세션 동안 같은 종류는 다시 묻지 않음 */
    behavior: z.enum(['allow', 'allow_session', 'deny']),
    /** 거부할 때 클로드에게 전할 말(선택) */
    message: z.string().max(MESSAGE_MAX_CHARS).optional(),
  }),
  z.object({
    type: z.literal('answer'),
    /** 질문 글 → 답. 여러 개를 고르면 ", "로 이어 붙인다. 직접 쓴 답도 그대로 넣는다. */
    answers: z.record(z.string().max(MESSAGE_MAX_CHARS)),
  }),
]);
export type ReplyAnswer = z.infer<typeof ReplyAnswerSchema>;

/** POST /api/reply/wait { requestId } */
export const ReplyWaitSchema = z.object({ requestId: z.string().min(1).max(100) });
/** gone: 터미널에서 먼저 답했거나 만료·삭제됨 — 훅은 아무 결정 없이 끝낸다. */
export type ReplyWaitResponse = { status: 'pending' } | { status: 'answered'; answer: ReplyAnswer } | { status: 'gone' };

/** POST /api/reply/inbox { sessionId, waiterId } — waiterId 는 훅 프로세스마다 새로 만든 uuid */
export const ReplyInboxSchema = z.object({ sessionId: z.string().min(1).max(200), waiterId: z.string().uuid() });
/** gone: 같은 세션에 새 대기자가 붙었거나 원격 답장이 꺼졌다 — 훅은 조용히 끝낸다. */
export type ReplyInboxResponse = { status: 'pending' } | { status: 'message'; id: string; text: string } | { status: 'gone' };

/** POST /api/sessions/:id/reply 의 body */
export const ReplyRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('permission'), requestId: z.string().min(1).max(100),
    behavior: z.enum(['allow', 'allow_session', 'deny']), message: z.string().max(MESSAGE_MAX_CHARS).optional(),
  }),
  z.object({ type: z.literal('answer'), requestId: z.string().min(1).max(100), answers: z.record(z.string().max(MESSAGE_MAX_CHARS)) }),
  /** 세션에 새 글 보내기. 작업 중이면 끝난 뒤에 전달된다. */
  z.object({ type: z.literal('message'), text: z.string().trim().min(1).max(MESSAGE_MAX_CHARS) }),
]);
export type ReplyRequest = z.infer<typeof ReplyRequestSchema>;
/**
 * 200 { ok: true, queued }  queued=true 면 글이 아직 전달 전(세션이 작업 중이거나 대기자가 없음)
 * 404 not_found             내 세션이 아님
 * 409 reply_disabled        컴퓨터의 원격 답장이 꺼져 있거나 플러그인이 낮음, 또는 종료·끊김 세션
 * 409 no_pending            그 승인·질문은 이미 끝났다(터미널에서 먼저 답함 등)
 */
export type ReplyResponse = { ok: true; queued: boolean };

/** 카드에 보일, 지금 기다리는 승인·질문 */
export type PendingView = {
  id: string;
  kind: 'permission' | 'question';
  toolName: string;
  /** 무엇을 하려는지 한 줄(명령·파일 경로 등, 최대 300자) */
  summary: string;
  sessionAllow: string | null;
  questions?: ReplyQuestion[];
  at: string;
  /** 이 세션에서 함께 기다리는 다른 요청 수 */
  more: number;
};

/** PATCH /api/machines/:id */
export const MachinePatchSchema = z.object({ remoteReply: z.boolean() });
