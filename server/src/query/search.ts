// 대화 검색: 한 세션의 대화 줄에서 글자를 찾아 최신 줄부터 돌려준다.
import type { LogSearchHit, LogSearchResponse } from '@c-monitor/shared';
import type { Q } from '../types';

/** snippet 최대 길이(글자 수, 양쪽의 … 포함). */
const SNIPPET_MAX = 160;
/** 찾은 글자 앞에 보여 줄 글자 수. */
const SNIPPET_LEAD = 40;
/** DB에서 가져오는 본문 조각: 찾은 자리 앞 WINDOW_LEAD자부터 WINDOW_CHARS자. 큰 본문을 통째로 옮기지 않는다. */
const WINDOW_LEAD = 80;
const WINDOW_CHARS = 400;

/**
 * 본문에서 찾은 글자 주변을 잘라 한 줄로 만든다.
 * - 줄바꿈·탭·이어진 공백은 공백 하나로
 * - 최대 160자(유니코드 글자 단위라 이모지가 반으로 잘리지 않는다), 잘린 쪽에는 …
 * - 본문에 찾는 글자가 없으면(도구 이름에서 찾은 경우) 앞부분을 쓴다
 * cutStart·cutEnd: 넘겨받은 text가 이미 원문의 앞·뒤가 잘린 조각일 때 그쪽에도 …를 붙인다.
 */
export function makeSnippet(text: string, query: string, cut: { cutStart?: boolean; cutEnd?: boolean } = {}): string {
  const cutStart = cut.cutStart === true;
  const cutEnd = cut.cutEnd === true;
  const norm = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(norm);
  const len = chars.length;

  const found = norm.toLowerCase().indexOf(query.replace(/\s+/g, ' ').trim().toLowerCase());
  const match = found < 0 ? 0 : Array.from(norm.slice(0, found)).length;

  // [s, e) 구간을 썼을 때의 전체 길이(… 포함)
  const size = (s: number, e: number): number => e - s + (cutStart || s > 0 ? 1 : 0) + (cutEnd || e < len ? 1 : 0);

  let start = Math.max(0, match - SNIPPET_LEAD);
  let end = len;
  if (size(0, len) <= SNIPPET_MAX) {
    start = 0;
  } else if (size(start, len) <= SNIPPET_MAX) {
    // 끝까지 다 들어간다 — 남는 만큼 앞쪽을 더 보여 준다.
    while (start > 0 && size(start - 1, len) <= SNIPPET_MAX) start -= 1;
  } else {
    end = start;
    while (end < len && size(start, end + 1) <= SNIPPET_MAX) end += 1;
  }
  const body = chars.slice(start, end).join('').trim();
  return `${cutStart || start > 0 ? '…' : ''}${body}${cutEnd || end < len ? '…' : ''}`;
}

/** ILIKE 패턴에서 %, _, \ 를 글자 그대로 찾게 한다(ESCAPE '\'와 함께 쓴다). */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

type HitRow = {
  seq: number; role: LogSearchHit['role']; at: Date; tool_name: string | null;
  total: number; win: string; cut_start: boolean; cut_end: boolean;
};

/**
 * 한 세션의 대화에서 q를 찾는다(대소문자 무시, 본문과 도구 이름). 최신 줄부터 limit개와 전체 개수.
 * 색인은 기본 키 (session_id, seq)를 쓴다 — 그 세션의 줄만 훑고, 최신순 정렬도 색인 순서 그대로다.
 */
export async function searchLog(sql: Q, sessionId: string, q: string, limit: number): Promise<LogSearchResponse> {
  const pattern = `%${escapeLike(q)}%`;
  const rows = await sql<HitRow[]>`
    SELECT m.seq, m.role, m.at, m.tool_name, m.total,
           substr(m.text, w.start, ${WINDOW_CHARS}) AS win,
           w.start > 1 AS cut_start,
           w.start + ${WINDOW_CHARS} - 1 < char_length(m.text) AS cut_end
    FROM (
      SELECT seq, role, at, tool_name, text, (count(*) OVER ())::int AS total
      FROM transcript_lines
      WHERE session_id = ${sessionId}
        AND (text ILIKE ${pattern} ESCAPE '\\' OR tool_name ILIKE ${pattern} ESCAPE '\\')
      ORDER BY seq DESC
      LIMIT ${limit}
    ) m
    CROSS JOIN LATERAL (
      SELECT greatest(strpos(lower(m.text), lower(${q})) - ${WINDOW_LEAD}, 1) AS start
    ) w
    ORDER BY m.seq DESC`;

  const hits = rows.map((r): LogSearchHit => {
    const hit: LogSearchHit = {
      seq: r.seq, role: r.role, at: r.at.toISOString(),
      snippet: makeSnippet(r.win, q, { cutStart: r.cut_start, cutEnd: r.cut_end }),
    };
    if (r.tool_name !== null) hit.toolName = r.tool_name;
    return hit;
  });
  return { hits, total: rows[0]?.total ?? 0 };
}
