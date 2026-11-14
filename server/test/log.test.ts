// 대화 조회(페이지 단위)와 대화 검색.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LogResponse, LogSearchResponse } from '@c-monitor/shared';
import { makeSnippet } from '../src/query/search';
import { ADMIN, makeHarness, makeTestDb, type TestDb } from './helpers';

let db: TestDb;
let h: ReturnType<typeof makeHarness>;
let admin: string;
let a: { cookie: string; id: string; token: string; machineId: string };
let b: { cookie: string; id: string };
let big: string; // 줄 250개짜리 세션
let small: string; // 검색용 세션
let empty: string; // 대화가 없는 세션

const LONG = `${'가'.repeat(300)} 바늘ABC ${'나'.repeat(300)}`;

beforeAll(async () => {
  db = await makeTestDb();
  h = makeHarness(db);
  admin = await h.login(ADMIN);
  const ua = await h.activeUser('a@example.com');
  b = await h.activeUser('b@example.com');
  a = { ...ua, ...(await h.connect(ua.cookie, 'pc-a')) };

  await h.ingest(a.token, h.batch([h.ev('big', 'UserPromptSubmit', { prompt: 'x' })], {
    transcript: [{ sessionId: 'big', seq: 0, lines: Array.from({ length: 250 }, (_, i) => h.line(`대화 줄 ${i}`)) }],
  }));
  await h.ingest(a.token, h.batch([h.ev('small', 'UserPromptSubmit', { prompt: 'x' })], {
    transcript: [{ sessionId: 'small', seq: 0, lines: [
      h.line('Hello World 첫 줄', { role: 'user' }),
      h.line('진행률 100% 완료'),
      h.line('진행률 1000 완료'),
      h.line('파일 이름 a_b.txt'),
      h.line('파일 이름 axb.txt'),
      h.line('경로 C:\\work\\proj-a'),
      h.line('목록을 봅니다', { role: 'tool', toolName: 'WebFetch', toolInput: { url: 'x' } }),
      h.line('hello again\n둘째 줄\t탭 뒤'),
      h.line(LONG),
      h.line(`🙂${'😀'.repeat(200)} 끝에 있는 HELLO`),
    ] }],
  }));
  await h.ingest(a.token, h.batch([h.ev('empty', 'UserPromptSubmit', { prompt: 'x' })]));
  big = encodeURIComponent(`${a.machineId}:big`);
  small = encodeURIComponent(`${a.machineId}:small`);
  empty = encodeURIComponent(`${a.machineId}:empty`);
});
afterAll(async () => { await db.drop(); });

const getLog = (session: string, q = '', cookie = a.cookie) => h.req('GET', `/api/sessions/${session}/log${q}`, { cookie });
const log = async (session: string, q = '') => (await (await getLog(session, q)).json()) as LogResponse;
const seqs = (r: LogResponse) => r.lines.map((l) => l.seq);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('대화 조회 — 페이지 단위', () => {
  it('쿼리가 없으면 가장 최근 100줄을 seq 오름차순으로 준다', async () => {
    const r = await log(big);
    expect(seqs(r)).toEqual(range(150, 249));
    expect(r).toMatchObject({ total: 250, hasMoreBefore: true, hasMoreAfter: false });
    expect(r.lines[0]).toMatchObject({ seq: 150, role: 'assistant', text: '대화 줄 150' });
  });

  it('before: 그 seq보다 앞선 줄 중 가장 가까운 줄들', async () => {
    const r = await log(big, '?before=150');
    expect(seqs(r)).toEqual(range(50, 149));
    expect(r).toMatchObject({ total: 250, hasMoreBefore: true, hasMoreAfter: true });

    const first = await log(big, '?before=50');
    expect(seqs(first)).toEqual(range(0, 49));
    expect(first).toMatchObject({ hasMoreBefore: false, hasMoreAfter: true });

    const none = await log(big, '?before=0');
    expect(none).toMatchObject({ lines: [], total: 250, hasMoreBefore: false, hasMoreAfter: true });
  });

  it('after: 그 seq보다 뒤 줄을 앞에서부터', async () => {
    const r = await log(big, '?after=99');
    expect(seqs(r)).toEqual(range(100, 199));
    expect(r).toMatchObject({ total: 250, hasMoreBefore: true, hasMoreAfter: true });

    const tail = await log(big, '?after=239');
    expect(seqs(tail)).toEqual(range(240, 249));
    expect(tail.hasMoreAfter).toBe(false);

    const none = await log(big, '?after=249');
    expect(none).toMatchObject({ lines: [], total: 250, hasMoreBefore: true, hasMoreAfter: false });

    expect(seqs(await log(big, '?after=-1&limit=3'))).toEqual([0, 1, 2]);
  });

  it('around: 그 seq가 가운데 오게 하고, 한쪽이 모자라면 다른 쪽으로 채운다', async () => {
    const head = await log(big, '?around=5');
    expect(seqs(head)).toEqual(range(0, 99));
    expect(head).toMatchObject({ total: 250, hasMoreBefore: false, hasMoreAfter: true });

    const mid = await log(big, '?around=120&limit=20');
    expect(seqs(mid)).toEqual(range(110, 129));
    expect(mid).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });

    const tail = await log(big, '?around=245');
    expect(seqs(tail)).toEqual(range(150, 249));
    expect(tail).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false });

    // 전체보다 큰 seq를 주면 마지막 쪽을 준다
    expect(seqs(await log(big, '?around=9999&limit=10'))).toEqual(range(240, 249));
  });

  it('limit: 기본 100, 최대 500, 범위를 벗어나거나 숫자가 아니면 400', async () => {
    expect(seqs(await log(big, '?limit=5'))).toEqual(range(245, 249));
    expect((await log(big, '?limit=500')).lines).toHaveLength(250);
    for (const bad of ['0', '501', '-1', 'abc', '1.5', '']) {
      const res = await getLog(big, `?limit=${bad}`);
      expect([bad, res.status]).toEqual([bad, 400]);
      expect(await res.json()).toEqual({ error: 'invalid_limit' });
    }
  });

  it('before·after·around는 한 번에 하나만, 정수가 아니면 400', async () => {
    for (const q of ['?before=10&after=5', '?before=10&around=5', '?after=1&around=5', '?before=abc', '?after=1.5', '?around=', '?after=99999999999']) {
      const res = await getLog(big, q);
      expect([q, res.status]).toEqual([q, 400]);
      expect(await res.json()).toEqual({ error: 'invalid_cursor' });
    }
  });

  it('대화가 없는 세션은 빈 결과', async () => {
    expect(await log(empty)).toEqual({ lines: [], total: 0, hasMoreBefore: false, hasMoreAfter: false });
    expect(await log(empty, '?around=3')).toEqual({ lines: [], total: 0, hasMoreBefore: false, hasMoreAfter: false });
  });

  it('남의 세션은 404, 관리자는 볼 수 있다', async () => {
    expect((await getLog(big, '', b.cookie)).status).toBe(404);
    expect((await getLog(big, '?before=10', b.cookie)).status).toBe(404);
    expect((await getLog(big, '', admin)).status).toBe(200);
    expect((await h.req('GET', `/api/sessions/${big}/log`)).status).toBe(401);
  });
});

const getSearch = (session: string, q: string, extra = '', cookie = a.cookie) =>
  h.req('GET', `/api/sessions/${session}/search?q=${encodeURIComponent(q)}${extra}`, { cookie });
const search = async (session: string, q: string, extra = '') =>
  (await (await getSearch(session, q, extra)).json()) as LogSearchResponse;

describe('대화 검색', () => {
  it('대소문자를 가리지 않고 찾으며 최신 줄이 먼저 온다', async () => {
    const r = await search(small, 'hello');
    expect(r.total).toBe(3);
    expect(r.hits.map((x) => x.seq)).toEqual([9, 7, 0]);
    expect(r.hits[2]).toMatchObject({ seq: 0, role: 'user', snippet: 'Hello World 첫 줄' });
    expect(new Date(r.hits[2]!.at).toISOString()).toBe(r.hits[2]!.at);
    expect(r.hits[2]).not.toHaveProperty('toolName');
    // 앞뒤 공백은 떼고 찾는다
    expect((await search(small, '  HELLO  ')).total).toBe(3);
  });

  it('%, _, \\ 는 글자 그대로 찾는다', async () => {
    expect((await search(small, '100%')).hits.map((x) => x.seq)).toEqual([1]);
    expect((await search(small, 'a_b')).hits.map((x) => x.seq)).toEqual([3]);
    expect((await search(small, 'work\\proj')).hits.map((x) => x.seq)).toEqual([5]);
    expect((await search(small, '%%')).total).toBe(0);
  });

  it('도구 이름에서도 찾고, 그때 snippet은 본문 앞부분이다', async () => {
    const r = await search(small, 'webfetch');
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ seq: 6, role: 'tool', toolName: 'WebFetch', snippet: '목록을 봅니다' });
  });

  it('snippet: 줄바꿈·탭은 공백 하나로, 최대 160자, 잘린 쪽에 …', async () => {
    const multi = (await search(small, 'again')).hits[0]!;
    expect(multi.snippet).toBe('hello again 둘째 줄 탭 뒤');

    const long = (await search(small, '바늘abc')).hits[0]!;
    expect(long.seq).toBe(8);
    expect(long.snippet).toContain('바늘ABC');
    expect(long.snippet.startsWith('…')).toBe(true);
    expect(long.snippet.endsWith('…')).toBe(true);
    expect(Array.from(long.snippet).length).toBeLessThanOrEqual(160);

    // 이모지가 반으로 잘리지 않는다(짝 없는 서로게이트가 없다)
    const emoji = (await search(small, '끝에 있는')).hits[0]!;
    expect(emoji.snippet.startsWith('…')).toBe(true);
    expect(emoji.snippet.endsWith('HELLO')).toBe(true);
    expect(Array.from(emoji.snippet).length).toBeLessThanOrEqual(160);
    expect(emoji.snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('total은 hits보다 클 수 있고, limit은 기본 50·최대 200', async () => {
    const r = await search(big, '대화 줄');
    expect(r.total).toBe(250);
    expect(r.hits).toHaveLength(50);
    expect(r.hits[0]!.seq).toBe(249);
    expect(r.hits[49]!.seq).toBe(200);
    expect((await search(big, '대화 줄', '&limit=3')).hits.map((x) => x.seq)).toEqual([249, 248, 247]);
    expect((await search(big, '대화 줄', '&limit=200')).hits).toHaveLength(200);
    for (const bad of ['0', '201', 'abc']) {
      const res = await getSearch(big, '대화 줄', `&limit=${bad}`);
      expect([bad, res.status]).toEqual([bad, 400]);
      expect(await res.json()).toEqual({ error: 'invalid_limit' });
    }
  });

  it('검색어가 2자 미만이거나 200자를 넘으면 400', async () => {
    for (const q of ['a', ' a ', '', '가'.repeat(201)]) {
      const res = await getSearch(small, q);
      expect([q.length, res.status]).toEqual([q.length, 400]);
      expect(await res.json()).toEqual({ error: 'invalid_query' });
    }
    expect((await h.req('GET', `/api/sessions/${small}/search`, { cookie: a.cookie })).status).toBe(400);
    expect((await getSearch(small, '가'.repeat(200))).status).toBe(200);
  });

  it('찾는 것이 없으면 빈 결과', async () => {
    expect(await search(small, '없는글자열')).toEqual({ hits: [], total: 0 });
  });

  it('남의 세션은 404, 관리자는 볼 수 있다', async () => {
    expect((await getSearch(small, 'hello', '', b.cookie)).status).toBe(404);
    expect((await getSearch('none', 'hello', '', b.cookie)).status).toBe(404);
    expect((await getSearch(small, 'hello', '', admin)).status).toBe(200);
    expect((await h.req('GET', `/api/sessions/${small}/search?q=hello`)).status).toBe(401);
  });
});

describe('makeSnippet', () => {
  it('짧은 본문은 그대로', () => {
    expect(makeSnippet('안녕하세요 여러분', '하세')).toBe('안녕하세요 여러분');
    expect(makeSnippet('  앞뒤 공백\r\n\r\n 여러 줄 ', '공백')).toBe('앞뒤 공백 여러 줄');
  });

  it('찾은 글자가 앞쪽이면 뒤만, 뒤쪽이면 앞만 자른다', () => {
    const front = makeSnippet(`바늘 ${'가'.repeat(400)}`, '바늘');
    expect(front.startsWith('바늘 가')).toBe(true);
    expect(front.endsWith('…')).toBe(true);
    expect(Array.from(front).length).toBe(160);

    const back = makeSnippet(`${'가'.repeat(400)} 바늘`, '바늘');
    expect(back.startsWith('…')).toBe(true);
    expect(back.endsWith(' 바늘')).toBe(true);
    expect(Array.from(back).length).toBe(160);
  });

  it('본문에 없으면(도구 이름에서 찾은 경우) 앞부분을 쓴다', () => {
    expect(makeSnippet('짧은 본문', 'Bash')).toBe('짧은 본문');
    const s = makeSnippet('다'.repeat(500), 'Bash');
    expect(s).toBe(`${'다'.repeat(159)}…`);
  });

  it('앞뒤가 이미 잘린 조각이면 그쪽에도 …를 붙인다', () => {
    expect(makeSnippet('가운데 바늘 조각', '바늘', { cutStart: true, cutEnd: true })).toBe('…가운데 바늘 조각…');
  });
});
