// 텔레그램 봇 API를 감싼 작은 클라이언트. 테스트에서는 같은 모양의 가짜를 Deps.telegramClient로 넣는다.
// 토큰은 요청 주소(…/bot<토큰>/…)에 들어가므로 오류 메시지·로그에는 redact()로 가린 글만 남긴다.

export type TgUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
export type TgChat = { id: number; type: string };
export type TgMessage = {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  reply_to_message?: { message_id: number };
};
export type TgCallbackQuery = { id: string; from: TgUser; message?: { message_id: number; chat: TgChat }; data?: string };
export type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery };

export type InlineButton = { text: string; callback_data?: string; url?: string };
export type InlineKeyboard = InlineButton[][];

export type SendMessageParams = {
  chat_id: number;
  text: string;
  parse_mode?: 'HTML';
  reply_markup?: { inline_keyboard: InlineKeyboard };
  link_preview_options?: { is_disabled: boolean };
};
export type EditMessageParams = {
  chat_id: number;
  message_id: number;
  text: string;
  parse_mode?: 'HTML';
  reply_markup?: { inline_keyboard: InlineKeyboard };
  link_preview_options?: { is_disabled: boolean };
};

export type TelegramClient = {
  getMe(): Promise<{ id: number; username: string }>;
  getUpdates(params: { offset?: number; timeout?: number; allowed_updates?: string[] }, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(params: SendMessageParams): Promise<{ message_id: number }>;
  editMessageText(params: EditMessageParams): Promise<unknown>;
  answerCallbackQuery(params: { callback_query_id: string; text?: string }): Promise<unknown>;
};

/** 텔레그램이 ok:false로 답했다. retryAfter는 429일 때 기다릴 초. */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`텔레그램 ${method} 실패(${code}): ${description}`);
    this.name = 'TelegramError';
  }
}

const TOKEN_PATTERN = /\d{5,}:[A-Za-z0-9_-]{20,}/g;

/** 글 안의 봇 토큰을 가린다(로그·lastError용). */
export function redact(text: string, token?: string): string {
  let out = token ? text.split(token).join('<토큰>') : text;
  out = out.replace(TOKEN_PATTERN, '<토큰>');
  return out;
}

/** 오류를 로그에 남길 한 줄로(토큰은 가린다). */
export function errorLine(err: unknown, token?: string): string {
  const raw = err instanceof Error ? `${err.message}${err.cause instanceof Error ? ` (${err.cause.message})` : ''}` : String(err);
  return redact(raw, token).slice(0, 300);
}

const API_BASE = 'https://api.telegram.org';
/** 한 번의 요청 제한시간(ms). getUpdates는 붙잡는 시간만큼 더 기다린다. */
const REQUEST_TIMEOUT_MS = 15_000;

export function createTelegramClient(token: string, fetchImpl: typeof fetch = fetch): TelegramClient {
  async function call<T>(method: string, params: unknown, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params ?? {}),
        signal,
      });
    } catch (err) {
      // 네트워크 오류 메시지에 주소가 섞여 나올 수 있다 — 가려서 다시 던진다.
      throw new Error(`텔레그램 ${method} 요청 실패: ${errorLine(err, token)}`);
    }
    const body = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } }
      | null;
    if (!body?.ok) {
      throw new TelegramError(
        method, body?.error_code ?? res.status, redact(body?.description ?? res.statusText, token), body?.parameters?.retry_after,
      );
    }
    return body.result as T;
  }

  return {
    getMe: () => call('getMe', {}),
    getUpdates: (params, signal) =>
      call('getUpdates', params, { signal, timeoutMs: (params.timeout ?? 0) * 1000 + REQUEST_TIMEOUT_MS }),
    sendMessage: (params) => call('sendMessage', params),
    editMessageText: (params) => call('editMessageText', params),
    answerCallbackQuery: (params) => call('answerCallbackQuery', params),
  };
}
