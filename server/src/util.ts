// 작은 공용 도구: 해시, 오류 응답, 본문 읽기.
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType, ZodTypeDef } from 'zod';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `{error}` JSON 본문으로 끝내는 예외를 만든다. `throw fail(404, 'not_found')` */
export function fail(status: number, error: string): HTTPException {
  return new HTTPException(status as ContentfulStatusCode, {
    res: Response.json({ error }, { status }),
  });
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Postgres가 받지 못하는 글자(NUL, 짝 없는 서로게이트)를 없앤다. */
export function cleanText(s: string): string {
  return s.replaceAll('\u0000', '').replace(LONE_SURROGATE, '�');
}

/** JSON 문자열을 풀면서 모든 문자열 값을 DB에 넣을 수 있게 다듬는다. 깨진 JSON이면 400. */
export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text, (_k, v) => (typeof v === 'string' ? cleanText(v) : v));
  } catch {
    throw fail(400, 'invalid_json');
  }
}

/** 요청 본문을 읽어 스키마로 검사한다. 맞지 않으면 400. */
export async function readBody<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const parsed = schema.safeParse(parseJsonBody(await c.req.text()));
  if (!parsed.success) throw fail(400, 'invalid_body');
  return parsed.data;
}

/** 본문을 최대 크기까지만 읽는다. 넘으면 null. */
export async function readLimitedText(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 앞에서 n글자만(유니코드 글자 단위). */
export function head(text: unknown, n = 200): string {
  if (typeof text !== 'string') return text == null ? '' : head(String(text), n);
  if (text.length <= n) return text;
  return Array.from(text.slice(0, n * 2)).slice(0, n).join('');
}
