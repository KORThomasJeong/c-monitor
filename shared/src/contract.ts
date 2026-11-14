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

export const SessionStatSchema = z.object({
  sessionId: z.string().min(1).max(200),
  /** 컨텍스트 사용률 0~100(소수 1자리). 알 수 없으면 null */
  contextPct: pct.nullable(),
  /** 세션 누적 비용(USD). 알 수 없으면 null */
  costUsd: z.number().min(0).nullable(),
  at: iso,
});
export type SessionStat = z.infer<typeof SessionStatSchema>;

export const IngestBatchSchema = z.object({
  machine: MachineInfoSchema,
  events: z.array(HookEventSchema).max(500),
  transcript: z.array(TranscriptChunkSchema).max(100),
  limits: LimitSnapshotSchema.optional(),
  /** 상태줄이 보내는 세션별 컨텍스트·비용(0.3.0 이상). 모르는 세션·남의 세션 항목은 서버가 조용히 건너뛴다(400 금지). */
  sessionStats: z.array(SessionStatSchema).max(100).optional(),
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
  /** 가입 고지에 동의한 시각. null이면 웹이 동의 화면을 먼저 보여 준다(동의 전에는 관리자에게 신청이 알려지지 않는다). */
  consentedAt: string | null;
  /** 탈퇴 신청 뒤 완전 삭제 예정 시각. null이면 탈퇴하지 않음. 값이 있으면 웹은 "탈퇴 취소" 화면만 보여 준다. */
  deleteAt: string | null;
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
  /** 상태줄이 보낸 마지막 컨텍스트 사용률(0~100)과 누적 비용(USD). 모르면 null */
  contextPct: number | null;
  costUsd: number | null;
  /** 이 세션의 알림을 텔레그램으로 받는가(세션별 스위치, 기본 켬). 사용자의 항목별 설정과 함께 적용된다. */
  telegram: boolean;
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

/** keepChatDays·keepUsageDays 가 0이면 지우지 않는다(3차). */
export type SettingsView = { lostMinutes: number; endHours: number; keepChatDays: number; keepUsageDays: number };

// ── 실시간 스트림(SSE) ────────────────────────────────────
export type StreamMessage =
  | ({ type: 'snapshot' } & DashboardSnapshot)
  | { type: 'session'; session: SessionView }
  | { type: 'log'; sessionId: string; lines: LogLine[] }
  | { type: 'limits'; account: AccountView }
  | { type: 'machine'; machine: MachineView }
  /** 세션이 지워졌다(사용자가 삭제). 화면에서 카드와 불러 둔 대화를 없앤다. */
  | { type: 'removed'; sessionIds: string[] }
  /** 웹·텔레그램에서 답한 기록(3차) */
  | { type: 'reply'; sessionId: string; reply: ReplyRecord };

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

// ══ 알림(텔레그램) ════════════════════════════════════════
// 공용 봇 하나. 사용자마다 설정 화면에서 연결 코드를 받아 봇에게 `/start <코드>`를 보내면 연결된다.
// 봇 토큰은 관리자가 웹의 관리 › 알림에서 넣는다(DB에 암호화해 저장, 다시 보여 주지 않음). 토큰이 없으면 텔레그램 기능 전체가 꺼진다(available=false).
//
// GET    /api/notify                 → NotifyView
// PUT    /api/notify/settings        NotifySettingsSchema → NotifyView
// POST   /api/notify/telegram/link   → TelegramLinkResponse (코드 10분 유효, 새로 받으면 옛 코드는 무효)
// DELETE /api/notify/telegram        → NotifyView (연결 끊기)
// POST   /api/notify/telegram/test   → { ok: true } / 409 { error: 'not_linked' } (시험 메시지 보내기)

export const NotifySettingsSchema = z.object({
  /** 답을 기다림(승인·질문·알림) — 기본 켬 */
  wait: z.boolean(),
  /** 작업이 끝남(작업 중 → 끝남) — 기본 켬 */
  done: z.boolean(),
  /** 연락 끊김 — 기본 켬 */
  lost: z.boolean(),
  /** 5시간·주간 한도가 limitPct% 를 넘음 — 기본 켬 */
  limit: z.boolean(),
  limitPct: z.number().int().min(50).max(100),
});
export type NotifySettings = z.infer<typeof NotifySettingsSchema>;
export const NOTIFY_DEFAULTS: NotifySettings = { wait: true, done: true, lost: true, limit: true, limitPct: 80 };

export type NotifyView = {
  telegram: {
    /** 서버에 봇이 설정돼 있는가 */
    available: boolean;
    /** 봇 사용자 이름(@ 없이). available=false 면 null */
    botUsername: string | null;
    linked: boolean;
    /** 연결된 텔레그램 계정 표시 이름(@아이디 또는 이름) */
    linkedName: string | null;
    linkedAt: string | null;
  };
  settings: NotifySettings;
};
export type TelegramLinkResponse = {
  code: string;
  /** https://t.me/<봇>?start=<코드> — 누르면 텔레그램이 열리고 "시작"을 누르면 연결된다 */
  url: string;
  expiresAt: string;
};

/** PATCH /api/sessions/:id — 세션별 설정(소유자만). → { session: SessionView } */
export const SessionPatchSchema = z.object({ telegram: z.boolean() });

// ── 관리자: 텔레그램 봇 ───────────────────────────────────
// GET    /api/admin/telegram   → AdminTelegramView
// PUT    /api/admin/telegram   AdminTelegramPutSchema → AdminTelegramView
//        서버가 getMe 로 토큰을 확인한 뒤 저장하고 받기 루프를 새 토큰으로 다시 시작한다. 틀리면 400 { error: 'invalid_token' }.
// DELETE /api/admin/telegram   → AdminTelegramView (봇 끄기 — 사용자 연결 정보는 남긴다)
export const AdminTelegramPutSchema = z.object({ token: z.string().trim().regex(/^[0-9]{5,}:[A-Za-z0-9_-]{30,}$/) });
export type AdminTelegramView = {
  configured: boolean;
  botUsername: string | null;
  /** 토큰 끝 4글자(확인용). 전체 토큰은 절대 내려주지 않는다. */
  tokenHint: string | null;
  updatedAt: string | null;
  /** 받기 루프 상태: ok / error(마지막 오류 한 줄) / off */
  polling: 'ok' | 'error' | 'off';
  lastError: string | null;
  /** 텔레그램을 연결한 사용자 수 */
  linkedUsers: number;
};

/**
 * POST /api/reply/inbox/ack { sessionId, id } → { ok: true }, 모르는 id는 404.
 * 0.3.0 이상 플러그인은 글을 세션에 넘긴 뒤 이것을 보낸다. 서버는 ack가 60초 안에 오지 않으면 그 글을 다시 준다
 * (0.3.0 미만 기기는 ack를 보내지 않으므로 넘긴 순간 전달 완료로 본다).
 */
export const ReplyInboxAckSchema = z.object({ sessionId: z.string().min(1).max(200), id: z.string().min(1).max(200) });
export type ReplyInboxAckResponse = { ok: true };

// ══ 3차 ═══════════════════════════════════════════════════
// 계획: docs/superpowers/plans/2026-11-14-plan3-rest.md

// ── 대시보드 바로 열기 ───────────────────────────────────
// 웹 주소 /?session=<encodeURIComponent(세션id)> 로 들어오면 그 세션 상세를 연다(텔레그램·웹 푸시 알림의 링크).

// ── 웹 답 기록 ────────────────────────────────────────────
// GET /api/sessions/:id/replies → { replies: ReplyRecord[] } (오래된 순, 최근 200개)
// 웹·텔레그램에서 답하거나 글을 보낼 때마다 하나씩 생기고, 스트림으로 { type:'reply', sessionId, reply } 가 나간다.
// 웹은 대화 줄 사이에 시각 순으로 끼워 "웹에서 「허용」으로 답했습니다" 처럼 보여 준다.
export type ReplyRecord = {
  id: string;
  at: string;
  source: 'web' | 'telegram';
  kind: 'permission' | 'answer' | 'message';
  /** 사람이 읽을 한 줄: "허용", "이 세션 동안 허용", "거부", 고른 답, 보낸 글 앞 200자 */
  label: string;
};

// ── 공유 ──────────────────────────────────────────────────
// POST   /api/sessions/:id/shares   ShareCreateSchema → ShareView (소유자만)
// GET    /api/sessions/:id/shares   → { shares: ShareView[] }
// DELETE /api/shares/:id            → { ok: true } (만든 사람만)
// 링크 공유: 로그인 없이 /s/<토큰> 에서 보기만. 토큰은 해시로 저장하므로 url 은 만들 때 한 번만 내려준다.
// 사람 지정: 가입한 사용자 이메일. 받은 사람의 대시보드 스냅샷·스트림에 sharedBy 가 붙은 세션으로 들어간다(보기만).
// 409 { error: 'user_not_found' }  사람 지정에서 가입하지 않은 이메일
// 409 { error: 'self' }            자기 자신
export const ShareCreateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('link'), expiresIn: z.enum(['1h', '1d', '7d', 'never']) }),
  z.object({ kind: z.literal('user'), email: z.string().trim().toLowerCase().email().max(320) }),
]);
export type ShareView = {
  id: string;
  kind: 'link' | 'user';
  /** link: 만들 때만 채운다(그 뒤로는 null) */
  url: string | null;
  email: string | null;
  expiresAt: string | null;
  createdAt: string;
};
/**
 * 로그인 없이 보는 공유 링크(토큰으로만):
 *   GET /api/public/s/:token         → PublicSessionView (만료·취소·세션 삭제·소유자 탈퇴면 404)
 *   GET /api/public/s/:token/log     → LogResponse (before/after/around/limit 같은 규칙)
 *   GET /api/public/s/:token/stream  → SSE: { type:'public', session: PublicSessionView } 와 { type:'log', lines } 만
 * 컴퓨터 정보·다른 세션·답장·원격 제어 주소·소유자 이메일은 절대 내보내지 않는다.
 */
export type PublicSessionView = {
  name: string; status: SessionStatus; branch: string | null; model: string | null;
  startedAt: string; lastEventAt: string; endedAt: string | null;
  activity: { label: string; text: string } | null;
  contextPct: number | null; costUsd: number | null;
  expiresAt: string | null;
};
/** GET /api/public/s/:token/stream 의 data 메시지(세션 id·컴퓨터 정보 없음). */
export type PublicStreamMessage =
  | { type: 'public'; session: PublicSessionView }
  | { type: 'log'; lines: LogLine[] };

// ── 계정: 동의·탈퇴 ───────────────────────────────────────
// POST /api/me/consent   → MeResponse (동의 시각 저장. 승인 대기 사용자면 이때 관리자에게 가입 신청 알림)
// POST /api/me/withdraw  → MeResponse (즉시 모든 API·기기 전송 차단, 공유 링크 무효, WITHDRAW_DAYS 뒤 완전 삭제)
// POST /api/me/restore   → MeResponse (deleteAt 전이면 되살린다. 기기 연결도 그대로 되살아난다)
// 탈퇴 중인 사용자는 /api/me·/api/me/restore·/auth/logout 만 쓸 수 있고 나머지는 403 { error: 'withdrawn' }.
export const WITHDRAW_DAYS = 7;

// ── 저장 용량 ─────────────────────────────────────────────
// GET /api/me/storage → StorageMe
// 매일 정리 때 사용자 사용량이 한도를 넘으면 오래된 대화 줄부터 지우고(최근 24시간 줄은 지우지 않음) 알림을 보낸다.
export const DEFAULT_QUOTA_MB = 1024;
export type StorageMe = { bytes: number; quotaMb: number; trimmedAt: string | null };

// ── 웹 푸시 ───────────────────────────────────────────────
// GET    /api/push/key            → { publicKey }  (VAPID 공개 키, 서버가 처음 뜰 때 만들어 DB에 둔다)
// GET    /api/push/subscriptions  → { subscriptions: { endpoint: string; label: string | null; createdAt: string }[] }
// POST   /api/push/subscribe      PushSubscribeSchema → { ok: true }  (같은 endpoint 는 덮어씀)
// DELETE /api/push/subscribe      { endpoint } → { ok: true }
// POST   /api/push/test           { endpoint } → { ok: true } / 404
// 웹 푸시는 텔레그램과 같은 NotifySettings 와 세션별 스위치(SessionView.telegram 을 "알림" 스위치로 함께 쓴다)를 따른다.
// 텔레그램 연결 여부와 상관없이 동작한다. 알림을 누르면 /?session=<id> 가 열린다. 만료(404·410)된 구독은 서버가 지운다.
export const PushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  /** 사람이 알아볼 이름(예: "Chrome · Windows") */
  label: z.string().max(100).optional(),
});

// ── 관리자 ────────────────────────────────────────────────
// GET    /api/admin/users              → { users: AdminUserView[] } (기존 응답에 필드 추가)
// POST   /api/admin/users              AdminUserCreateSchema → AdminUserView (미리 추가: 첫 로그인 때 승인 없이 사용, 동의는 받음)
// PATCH  /api/admin/users/:id          AdminUserPatchSchema → AdminUserView (권한·용량 한도. 자기 자신의 관리자 권한은 못 내림)
// POST   /api/admin/users/:id/restore  → AdminUserView (탈퇴 취소)
// DELETE /api/admin/users/:id          → { ok: true } (즉시 완전 삭제. 자기 자신 불가)
// GET    /api/admin/machines           → { machines: AdminMachineView[] }
// PATCH  /api/admin/machines/:id       MachinePatchSchema → AdminMachineView
// DELETE /api/admin/machines/:id       → { ok: true } (연결 해제)
// GET    /api/admin/storage            → AdminStorageView
// 관리자가 남의 대시보드 보기: GET /api/sessions?user=<id> (이미 있음), GET /api/stream?user=<id> (관리자만).
// 이때 웹은 읽기 전용(답장·삭제·설정 숨김), 서버도 남의 세션에 대한 쓰기는 404로 막는다.
export const AdminUserCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(['admin', 'user']),
});
export const AdminUserPatchSchema = z.object({
  role: z.enum(['admin', 'user']).optional(),
  /** 0 = 무제한 */
  quotaMb: z.number().int().min(0).max(1_000_000).optional(),
});
export type AdminUserView = UserView & {
  createdAt: string; lastLoginAt: string | null;
  quotaMb: number; bytes: number; machines: number;
  /** 관리자가 미리 추가했지만 아직 로그인하지 않음 */
  invited: boolean;
};
export type AdminMachineView = MachineView & { ownerId: string; ownerEmail: string; account: string | null };
export type AdminStorageView = {
  totalBytes: number; chatBytes: number; usageBytes: number; otherBytes: number;
  /** 서버 디스크 남은 공간(알 수 없으면 null) */
  diskFreeBytes: number | null;
  users: { id: string; email: string; bytes: number; quotaMb: number }[];
};
