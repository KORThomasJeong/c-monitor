/*
 * C-Monitor 화면 데모용 가짜 서버.
 *
 * 앱(React)보다 먼저 실행돼 window.fetch와 window.EventSource를 가로채고,
 * 지어낸 예시 데이터로 서버 API에 계약(shared/src/contract.ts)대로 답한다.
 * 실제 서버와는 전혀 연결되지 않는다. 모든 이메일·컴퓨터·프로젝트 이름은 지어낸 값이다.
 *
 * 주소 쿼리로 시작 화면을 고른다.
 *   app.html?view=/settings&theme=dark&mode=deck&user=admin&sel=search-api
 *   - view  : / · /login · /pending · /connect?code=… · /settings · /admin
 *   - theme : light | dark            (앱이 기억하는 테마 값을 덮어쓴다)
 *   - mode  : detail | deck           (대시보드 상세 / 간단히 보기)
 *   - user  : admin | user | pending  (로그인한 사람의 권한·상태, 기본 admin)
 *   - sel   : 세션 이름 또는 id       (대시보드에서 그 세션 상세를 연다)
 *             대화가 긴 세션은 api-gateway(200줄 넘음). "이전 대화 더 보기"와 검색을 눌러 볼 수 있다.
 *
 * 원격 답장(2차): search-api는 승인 대기, blog-site는 질문 대기(pending)라 카드·상세에서 바로 답해 볼 수 있다.
 * 답하면 pending이 사라지고 작업 중으로 바뀌며 대화에 한 줄이 붙는다. 글을 보내면 잠시 뒤 답이 온다
 * (작업 중이면 쌓아 두었다가 작업이 끝날 때 전달). 설정의 "원격 답장" 스위치를 끄면 그 컴퓨터 세션에는 답할 수 없다.
 *
 * 텔레그램 알림(3차): 서버에 봇(@c_monitor_demo_bot, 지어낸 이름)이 있고 처음엔 연결 안 됨이다. 설정 › 알림에서
 * "텔레그램 연결"을 누르면 코드가 나오고 몇 초 뒤 연결됨으로 바뀐다(실제 텔레그램은 열지 않는다).
 * 관리 › 알림에서 봇 토큰 바꾸기·끄기, 상세 패널에서 세션별 텔레그램 알림 켜기/끄기를 해 볼 수 있다(api-gateway는 꺼 둠).
 *
 * 3차(나머지 전부):
 *   - 공유: 상세 패널 "공유"로 링크 만들기·사람 지정·취소. 공개 보기는 app.html?view=/s/demo (로그인 없이 보기만, 실시간).
 *   - 공유받은 세션: designer@example.com 이 공유한 세션 두 개가 "공유받은 세션" 묶음에 보인다(보기만).
 *   - 기록 탭: "현재 / 기록"에서 기록을 누르면 오래전에 끝난 세션까지 보인다.
 *   - 관리: 사용자(추가·권한·용량 한도·탈퇴 예정 복구·즉시 삭제·대시보드 보기), 모든 컴퓨터, 저장 용량.
 *     "대시보드 보기"는 /?user=u-member 처럼 그 사람의 대시보드를 읽기 전용으로 연다.
 *   - 동의·탈퇴: user=consent 는 동의 전 사용자(동의 화면), user=leaving 은 탈퇴 신청한 사용자(탈퇴 취소 화면).
 *   - 웹 알림: 데모 브라우저는 지원하지 않는 것으로 친다(안내만). 이 계정에 켜 둔 브라우저 하나가 목록에 있다.
 *   - 컨텍스트 %·비용, 웹·텔레그램 답 기록 줄(drawing-review에 텔레그램 기록, 웹에서 답하면 새 줄).
 *   - 바로 열기: app.html?view=/%3Fsession%3Ddemo-search-api
 *
 * 앱은 location.pathname으로 화면을 고르므로 여기서 history.replaceState로 주소를 view 값으로 바꾼다.
 * 그러면 상대 경로 자산이 엉뚱한 곳을 가리키게 되므로, 빌드 스크립트가 넣어 둔 자산 목록
 * (window.__CMON_DEMO_ASSETS__)을 원래 주소 기준 절대 주소로 바꿔 직접 불러온다.
 */
(function () {
  'use strict';

  // ── 시작 설정 ───────────────────────────────────────────
  var BASE = new URL('.', location.href).href;
  // 검색 결과 한 줄. 실제 서버(server/src/query/search.ts 의 searchLog + makeSnippet)와 같은 규칙:
  // 찾은 자리 80자 앞부터 400자를 떼어 낸 뒤, 공백을 하나로 줄이고 찾은 글자 40자 앞부터 최대 160자(… 포함).
  function searchSnippet(text, needle) {
    var all = Array.from(text);
    var at = text.toLowerCase().indexOf(needle);
    var pos = at < 0 ? 0 : Array.from(text.slice(0, at)).length + 1; // SQL strpos처럼 1부터, 없으면 0
    var from = Math.max(pos - 80, 1);
    var cutStart = from > 1;
    var cutEnd = from + 400 - 1 < all.length;
    var norm = all.slice(from - 1, from - 1 + 400).join('').replace(/\s+/g, ' ').trim();
    var chars = Array.from(norm);
    var len = chars.length;
    var found = norm.toLowerCase().indexOf(needle.replace(/\s+/g, ' ').trim());
    var match = found < 0 ? 0 : Array.from(norm.slice(0, found)).length;
    var size = function (a, b) { return b - a + (cutStart || a > 0 ? 1 : 0) + (cutEnd || b < len ? 1 : 0); };
    var start = Math.max(0, match - 40);
    var end = len;
    if (size(0, len) <= 160) {
      start = 0;
    } else if (size(start, len) <= 160) {
      while (start > 0 && size(start - 1, len) <= 160) start -= 1;
    } else {
      end = start;
      while (end < len && size(start, end + 1) <= 160) end += 1;
    }
    return (cutStart || start > 0 ? '…' : '') + chars.slice(start, end).join('').trim() + (cutEnd || end < len ? '…' : '');
  }

  var params = new URLSearchParams(location.search);
  var THEME_KEY = 'cs-theme';
  var MODE_KEY = 'cs-mode';
  var ALLOWED = ['/', '/login', '/pending', '/connect', '/settings', '/admin', '/withdrawn'];

  var startView = (function () {
    var raw = params.get('view') || '/';
    if (raw.charAt(0) !== '/' || raw.charAt(1) === '/') raw = '/';
    var u = new URL(raw, 'http://demo.invalid');
    if (ALLOWED.indexOf(u.pathname) < 0 && !/^\/s\/[A-Za-z0-9_-]+$/.test(u.pathname)) return '/';
    return u.pathname + u.search + u.hash;
  })();
  var startPath = startView.split(/[?#]/)[0];
  var userKind = ['admin', 'user', 'pending', 'consent', 'leaving'].indexOf(params.get('user')) >= 0 ? params.get('user') : 'admin';
  var selWanted = params.get('sel');

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 사생활 보호 모드 등 */ }
  }
  var theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') store(THEME_KEY, theme);
  var mode = params.get('mode');
  if (selWanted) mode = 'detail';
  if (mode === 'detail' || mode === 'deck') store(MODE_KEY, mode);
  else if (startPath === '/' && params.has('view')) store(MODE_KEY, 'detail');

  // ── 시간 도우미 ─────────────────────────────────────────
  var T0 = Date.now();
  var MIN = 60000;
  function iso(ms) { return new Date(ms).toISOString(); }
  function ago(minutes) { return iso(T0 - minutes * MIN); }
  function nowIso() { return iso(Date.now()); }
  function sec(ms) { return Math.floor(ms / 1000); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  // ── 예시 데이터(전부 지어낸 값) ─────────────────────────
  var ACC_A = 'dev@company-a.example';
  var ACC_B = 'dev@company-b.example';

  var DAY = 24 * 60;
  var MB = 1024 * 1024;
  var USERS = [
    { id: 'u-admin', email: 'admin@example.com', name: '관리자', role: 'admin', status: 'active', createdAt: ago(DAY * 40),
      consentedAt: ago(DAY * 40), deleteAt: null, lastLoginAt: ago(1), quotaMb: 0, invited: false },
    { id: 'u-member', email: 'member@example.com', name: '홍길동', role: 'user', status: 'active', createdAt: ago(DAY * 21),
      consentedAt: ago(DAY * 21), deleteAt: null, lastLoginAt: ago(60 * 3), quotaMb: 1024, invited: false },
    { id: 'u-design', email: 'designer@example.com', name: '성춘향', role: 'user', status: 'active', createdAt: ago(DAY * 9),
      consentedAt: ago(DAY * 9), deleteAt: null, lastLoginAt: ago(25), quotaMb: 2048, invited: false },
    { id: 'u-new1', email: 'newcomer@example.com', name: '이몽룡', role: 'user', status: 'pending', createdAt: ago(35),
      consentedAt: ago(34), deleteAt: null, lastLoginAt: ago(35), quotaMb: 1024, invited: false },
    { id: 'u-new2', email: 'intern@example.com', name: null, role: 'user', status: 'pending', createdAt: ago(60 * 5),
      consentedAt: ago(60 * 5), deleteAt: null, lastLoginAt: ago(60 * 5), quotaMb: 1024, invited: false },
    { id: 'u-old', email: 'former@example.com', name: '심청', role: 'user', status: 'suspended', createdAt: ago(DAY * 70),
      consentedAt: ago(DAY * 70), deleteAt: null, lastLoginAt: ago(DAY * 30), quotaMb: 1024, invited: false },
    { id: 'u-fresh', email: 'fresh@example.com', name: '새내기', role: 'user', status: 'active', createdAt: ago(DAY * 1),
      consentedAt: null, deleteAt: null, lastLoginAt: ago(2), quotaMb: 1024, invited: false },
    { id: 'u-leave', email: 'leaving@example.com', name: '흥부', role: 'user', status: 'active', createdAt: ago(DAY * 50),
      consentedAt: ago(DAY * 50), deleteAt: iso(T0 + 5 * DAY * MIN), lastLoginAt: ago(DAY * 2), quotaMb: 1024, invited: false },
    { id: 'u-invite', email: 'invited@example.com', name: null, role: 'user', status: 'active', createdAt: ago(DAY * 2),
      consentedAt: null, deleteAt: null, lastLoginAt: null, quotaMb: 1024, invited: true },
  ];
  /** 사용자별 저장 용량(바이트, 지어낸 값) */
  var USAGE = {
    'u-admin': 412 * MB, 'u-member': 1010 * MB, 'u-design': 260 * MB, 'u-new1': 0, 'u-new2': 0,
    'u-old': 35 * MB, 'u-fresh': 2 * MB, 'u-leave': 88 * MB, 'u-invite': 0,
  };
  var ME_BY_KIND = {
    admin: 'u-admin',
    user: 'u-member',
    pending: 'u-new1',
    consent: 'u-fresh',
    leaving: 'u-leave',
  };
  var meId = ME_BY_KIND[userKind];
  var loggedIn = startPath !== '/login';

  /** 데모 컴퓨터의 플러그인 버전. plugin/.claude-plugin/plugin.json 의 version 과 맞춘다(올릴 때 같이 고친다). */
  var PLUGIN_VER = '0.3.1';
  var machines = [
    { id: 'm-home', name: '집 PC', os: 'Windows 11', pluginVersion: PLUGIN_VER, lastSeenAt: ago(0), online: true, remoteReply: true },
    { id: 'm-srv', name: 'server-a', os: 'Ubuntu 24.04', pluginVersion: PLUGIN_VER, lastSeenAt: ago(0.5), online: true, remoteReply: true },
    { id: 'm-build', name: 'build-vm', os: 'Ubuntu 22.04', pluginVersion: PLUGIN_VER, lastSeenAt: ago(1), online: true, remoteReply: true },
    { id: 'm-cloud', name: 'cloud-box', os: 'Debian 12', pluginVersion: PLUGIN_VER, lastSeenAt: ago(38), online: false, remoteReply: true },
  ];

  function history7(values) {
    return values.map(function (v, i) { return { at: ago((values.length - 1 - i) * 24 * 60 + 30), sevenDayPct: v }; });
  }
  var accounts = [
    {
      email: ACC_A, alias: '회사', hidden: false,
      fiveHourPct: 86, fiveHourResetsAt: sec(T0 + 107 * MIN),
      sevenDayPct: 63, sevenDayResetsAt: sec(T0 + (3 * 24 * 60 + 5 * 60) * MIN),
      at: ago(0.2), history: history7([21, 28, 34, 41, 47, 55, 63]),
    },
    {
      email: ACC_B, alias: null, hidden: false,
      fiveHourPct: 31, fiveHourResetsAt: sec(T0 + 200 * MIN),
      sevenDayPct: 44, sevenDayResetsAt: sec(T0 + 5 * 24 * 60 * MIN),
      at: ago(1), history: history7([12, 15, 22, 26, 31, 38, 44]),
    },
  ];

  var settings = { lostMinutes: 10, endHours: 24, keepChatDays: 30, keepUsageDays: 90 };

  // ── 3차: 공유·답 기록·웹 알림·남의 컴퓨터(전부 지어낸 값) ──
  /** 공개 링크 토큰 → 세션. "demo" 토큰은 search-api를 보여 준다(app.html?view=/s/demo). */
  var publicLinks = {
    demo: { sessionId: 'demo-search-api', shareId: 'sh-demo', expiresAt: iso(T0 + 7 * 24 * 60 * MIN) },
  };
  /** 세션 id → 공유 목록(ShareView, url은 만들 때만) */
  var shares = {
    'demo-search-api': [
      { id: 'sh-demo', kind: 'link', url: null, email: null, expiresAt: iso(T0 + 7 * 24 * 60 * MIN), createdAt: ago(60) },
      { id: 'sh-user-1', kind: 'user', url: null, email: 'member@example.com', expiresAt: null, createdAt: ago(40) },
    ],
  };
  var shareSeq = 1;
  var revokedTokens = {};
  /** 세션 id → 웹·텔레그램 답 기록 */
  var replyRecs = {};
  var replySeq = 0;
  function recordReply(sid, kind, label, source) {
    replySeq += 1;
    var r = { id: 'rr-' + replySeq, at: nowIso(), source: source || 'web', kind: kind, label: String(label).slice(0, 200) };
    (replyRecs[sid] = replyRecs[sid] || []).push(r);
    publish({ type: 'reply', sessionId: sid, reply: clone(r) });
    return r;
  }
  /** 이 계정에 웹 알림을 켜 둔 브라우저(데모 브라우저 자체는 지원하지 않는 것으로 친다) */
  var pushSubs = [
    { endpoint: 'https://push.example.invalid/demo-phone', label: 'Chrome · Android', createdAt: ago(2 * 24 * 60) },
  ];
  /** 다른 사용자의 컴퓨터(관리 › 컴퓨터, 관리자가 남의 대시보드를 볼 때) */
  var OTHER_MACHINES = {
    'u-member': [
      { id: 'm-mem-lap', name: '홍길동 노트북', os: 'macOS 15', pluginVersion: PLUGIN_VER, lastSeenAt: ago(1), online: true, remoteReply: true },
    ],
    'u-design': [
      { id: 'm-des', name: '디자인 맥', os: 'macOS 14', pluginVersion: PLUGIN_VER, lastSeenAt: ago(0.5), online: true, remoteReply: false },
    ],
    'u-leave': [
      // 일부러 낮은 버전(원격 답장 최소 0.2.0 미만): 관리 › 컴퓨터에서 "업데이트 필요" 태그를 보여 주는 예시.
      { id: 'm-leave', name: 'old-desktop', os: 'Windows 10', pluginVersion: '0.1.0', lastSeenAt: ago(2 * 24 * 60), online: false, remoteReply: false },
    ],
  };
  var OTHER_ACCOUNTS = { 'u-member': 'dev@company-b.example', 'u-design': 'dev@company-c.example', 'u-leave': null };
  /** 다른 사용자의 클로드 계정 한도(관리자가 남의 대시보드를 볼 때 그 사람의 한도 카드). 서버도 그 사용자의 계정을 돌려준다. */
  var OTHER_LIMITS = {
    'u-member': [
      {
        email: 'dev@company-b.example', alias: '팀', hidden: false,
        fiveHourPct: 42, fiveHourResetsAt: sec(T0 + 150 * MIN),
        sevenDayPct: 57, sevenDayResetsAt: sec(T0 + (2 * 24 * 60 + 8 * 60) * MIN),
        at: ago(1), history: history7([18, 24, 31, 38, 44, 51, 57]),
      },
    ],
    'u-design': [
      {
        email: 'dev@company-c.example', alias: null, hidden: false,
        fiveHourPct: 9, fiveHourResetsAt: sec(T0 + 240 * MIN),
        sevenDayPct: 22, sevenDayResetsAt: sec(T0 + 6 * 24 * 60 * MIN),
        at: ago(0.5), history: history7([5, 8, 11, 14, 17, 19, 22]),
      },
    ],
  };
  /** 관리자가 남의 대시보드를 볼 때의 한 화면분(쓰기 정보는 비운다). 내 것이면 평소 스냅샷. */
  function snapshotFor(uid, all) {
    if (!uid || uid === meId) return snapshot(all);
    var list = otherSessions.filter(function (s) { return s.ownerId === uid; }).map(function (s) {
      var v = clone(s);
      delete v.ownerId;
      v.canReply = false;
      v.queuedMessages = 0;
      v.pending = null;
      v.remoteUrl = null;
      return v;
    });
    return { sessions: list, machines: clone(OTHER_MACHINES[uid] || []), accounts: clone(OTHER_LIMITS[uid] || []) };
  }
  /** 공개 링크 보기(PublicSessionView). 없거나 만료·세션 삭제면 null. */
  function publicView(token) {
    var link = Object.prototype.hasOwnProperty.call(publicLinks, token) ? publicLinks[token] : null;
    // 새 창(새 데모)에서 연 링크: 토큰에 적힌 세션 이름으로 다시 만든다. 이 창에서 취소한 링크는 되살리지 않는다.
    var made = /^demo\d+_([A-Za-z0-9-]+)$/.exec(token);
    if (!link && made && !revokedTokens[token]) link = publicLinks[token] = { sessionId: 'demo-' + made[1], shareId: null, expiresAt: null };
    if (!link) return null;
    if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now()) return null;
    var s = sessionById(link.sessionId);
    if (!s) return null;
    return {
      name: s.name, status: s.status, branch: s.branch, model: s.model, startedAt: s.startedAt, lastEventAt: s.lastEventAt,
      endedAt: s.endedAt, activity: clone(s.activity), contextPct: s.contextPct, costUsd: s.costUsd, expiresAt: link.expiresAt,
    };
  }
  /** 대화 한 쪽(계약의 before/after/around/limit 규칙). 잘못된 쿼리면 null. */
  function pageOf(all, q) {
    var keys = ['before', 'after', 'around'].filter(function (k) { return q.has(k); });
    if (keys.length > 1) return null;
    var limit = q.has('limit') ? Number(q.get('limit')) : 100;
    if (!Number.isInteger(limit) || limit < 1) limit = 100;
    limit = Math.min(limit, 500);
    var picked;
    if (keys.length === 0) picked = all.slice(-limit);
    else {
      var at = Number(q.get(keys[0]));
      if (!Number.isInteger(at)) return null;
      if (keys[0] === 'after') picked = all.filter(function (l) { return l.seq > at; }).slice(0, limit);
      else if (keys[0] === 'before') picked = all.filter(function (l) { return l.seq < at; }).slice(-limit);
      else {
        var idx = Math.max(0, Math.min(all.length - limit, at - Math.floor(limit / 2)));
        picked = all.slice(idx, idx + limit);
      }
    }
    return {
      lines: clone(picked), total: all.length,
      hasMoreBefore: picked.length > 0 ? picked[0].seq > 0 : false,
      hasMoreAfter: picked.length > 0 ? picked[picked.length - 1].seq < all.length - 1 : false,
    };
  }

  // 텔레그램 알림. 봇 이름·토큰 끝자리는 지어낸 값이다.
  var DEMO_BOT = 'c_monitor_demo_bot';
  var adminTg = {
    configured: true, botUsername: DEMO_BOT, tokenHint: 'De4o', updatedAt: ago(60 * 24 * 3),
    polling: 'ok', lastError: null, linkedUsers: 2,
  };
  var notify = {
    linked: false, linkedName: null, linkedAt: null,
    settings: { wait: true, done: true, lost: true, limit: true, limitPct: 80 },
  };
  var linkTimer = null;
  function notifyView() {
    var on = adminTg.configured;
    return {
      telegram: {
        available: on, botUsername: on ? adminTg.botUsername : null,
        linked: notify.linked, linkedName: notify.linked ? notify.linkedName : null, linkedAt: notify.linked ? notify.linkedAt : null,
      },
      settings: clone(notify.settings),
    };
  }

  function S(o) {
    return Object.assign({
      account: ACC_A, branch: 'main', model: 'claude-sonnet-4-5', status: 'run', seen: true,
      endedAt: null, activity: null, pending: null, canReply: false, queuedMessages: 0, remoteUrl: null, telegram: true,
      contextPct: null, costUsd: null,
    }, o, { id: 'demo-' + o.name });
  }
  var sessions = [
    S({ name: 'search-api', machineId: 'm-home', cwd: 'D:\\work\\search-api', branch: 'fix/recency-rank', model: 'claude-opus-4-5',
      status: 'wait', seen: false, startedAt: ago(46), lastEventAt: ago(0.4),
      activity: { label: '알림', text: 'Claude needs your permission to use Bash' },
      remoteUrl: 'https://claude.ai/code/session_demo',
      pending: { id: 'req-1', kind: 'permission', toolName: 'Bash', summary: 'npm run migrate -- --env staging',
        sessionAllow: '이 세션 동안 npm run migrate 명령은 다시 묻지 않습니다', at: ago(0.4), more: 0 } }),
    S({ name: 'blog-site', machineId: 'm-home', account: ACC_B, cwd: 'D:\\work\\blog-site', branch: 'feat/post-list',
      status: 'wait', seen: true, startedAt: ago(22), lastEventAt: ago(2),
      activity: { label: 'AskUserQuestion', text: '글 목록을 어떻게 나눌까요? (페이지 번호 / 무한 스크롤)' },
      pending: { id: 'req-2', kind: 'question', toolName: 'AskUserQuestion', summary: '글 목록을 어떻게 나눌까요?',
        sessionAllow: null, at: ago(2), more: 0,
        questions: [{ question: '글 목록을 어떻게 나눌까요?', header: '목록 나누기', options: [
          { label: '페이지 번호', description: '주소가 /posts/2처럼 나뉘어 검색 엔진에 유리합니다' },
          { label: '무한 스크롤', description: '휴대폰에서 넘기기 편하지만 특정 글 위치를 다시 찾기 어렵습니다' },
        ] }] } }),
    S({ name: 'data-pipeline', machineId: 'm-home', account: ACC_B, cwd: 'D:\\work\\data-pipeline', branch: 'main',
      status: 'run', startedAt: ago(14), lastEventAt: ago(0.2),
      activity: { label: 'Bash', text: 'python -m pipeline.run --date 2026-11-13' } }),
    S({ name: 'drawing-review', machineId: 'm-srv', cwd: '/home/dev/drawing-review', branch: 'feat/pdf-report', model: 'claude-opus-4-5',
      status: 'done', startedAt: ago(95), lastEventAt: ago(3),
      activity: { label: '완료', text: 'PDF 리포트 기능을 마무리했습니다. 테스트 42개가 모두 통과했습니다.' } }),
    S({ name: 'homepage', machineId: 'm-srv', account: ACC_B, cwd: '/home/dev/homepage', branch: 'redesign',
      status: 'run', startedAt: ago(31), lastEventAt: ago(0.1),
      activity: { label: 'Edit', text: 'src/components/Hero.astro' } }),
    S({ name: 'api-gateway', machineId: 'm-build', cwd: '/srv/work/api-gateway', branch: 'refactor/auth-middleware', model: 'claude-opus-4-5',
      status: 'run', startedAt: ago(128), lastEventAt: ago(0.3), telegram: false,
      activity: { label: 'Bash', text: 'npm test -- --run auth' } }),
    S({ name: 'report-batch', machineId: 'm-build', cwd: '/srv/work/report-batch', branch: 'main',
      status: 'limit', seen: false, startedAt: ago(70), lastEventAt: ago(9),
      activity: { label: '실패', text: 'rate_limit' } }),
    S({ name: 'mobile-app', machineId: 'm-cloud', account: ACC_B, cwd: '/home/dev/mobile-app', branch: 'release/1.4',
      status: 'lost', startedAt: ago(64), lastEventAt: ago(38),
      activity: { label: 'Bash', text: 'npx expo export --platform android' } }),
    S({ name: 'infra-scripts', machineId: 'm-cloud', cwd: '/home/dev/infra-scripts', branch: 'main',
      status: 'end', startedAt: ago(240), lastEventAt: ago(185), endedAt: ago(185),
      activity: { label: '종료', text: 'prompt_input_exit' } }),
  ];
  // 컨텍스트 사용률(%)·누적 비용(USD) — 상태줄이 보내는 값을 흉내 낸다.
  var STATS = {
    'search-api': [64, 3.12], 'blog-site': [48, 1.97], 'data-pipeline': [22, 0.41], 'drawing-review': [71, 6.4],
    'homepage': [31, 0.84], 'api-gateway': [88, 7.25], 'report-batch': [96, 4.1], 'mobile-app': [17, 0.22], 'infra-scripts': [55, 2.05],
  };
  sessions.forEach(function (s) {
    var st = STATS[s.name];
    if (st) { s.contextPct = st[0]; s.costUsd = st[1]; }
  });
  // 공유받은 세션(designer@example.com 이 사람 지정으로 공유). 보기만 할 수 있다.
  sessions.push(
    S({ name: 'design-system', machineId: 'm-shared', account: 'dev@company-c.example', cwd: '/Users/design/design-system', branch: 'tokens/v2',
      status: 'run', startedAt: ago(25), lastEventAt: ago(0.5), sharedBy: 'designer@example.com', contextPct: 35, costUsd: 1.2,
      activity: { label: 'Edit', text: 'tokens/color.json' } }),
    S({ name: 'landing-copy', machineId: 'm-shared', account: 'dev@company-c.example', cwd: '/Users/design/landing-copy', branch: 'main',
      status: 'end', startedAt: ago(150), lastEventAt: ago(90), endedAt: ago(90), sharedBy: 'designer@example.com', contextPct: 12, costUsd: 0.3,
      activity: { label: '종료', text: 'prompt_input_exit' } })
  );
  // 오래전에 끝난 세션(종료 카드 유지 시간이 지나 "기록" 탭에서만 보인다).
  sessions.push(
    S({ name: 'legacy-migration', machineId: 'm-srv', cwd: '/home/dev/legacy-migration', branch: 'chore/db-upgrade',
      status: 'end', startedAt: ago(3 * 24 * 60 + 90), lastEventAt: ago(3 * 24 * 60), endedAt: ago(3 * 24 * 60), contextPct: 77, costUsd: 9.8,
      activity: { label: '종료', text: 'prompt_input_exit' } }),
    S({ name: 'docs-cleanup', machineId: 'm-home', account: ACC_B, cwd: 'D:\\work\\docs-cleanup', branch: 'main',
      status: 'end', startedAt: ago(5 * 24 * 60 + 40), lastEventAt: ago(5 * 24 * 60), endedAt: ago(5 * 24 * 60), contextPct: 19, costUsd: 0.6,
      activity: { label: '종료', text: 'prompt_input_exit' } })
  );
  // 다른 사용자의 세션(관리자가 "대시보드 보기"로 볼 때만). ownerId가 있으면 내 대시보드에는 나오지 않는다.
  var otherSessions = [
    S({ name: 'member-notes', ownerId: 'u-member', machineId: 'm-mem-lap', account: 'dev@company-b.example', cwd: '/Users/hong/notes',
      status: 'run', startedAt: ago(18), lastEventAt: ago(0.3), contextPct: 26, costUsd: 0.5,
      activity: { label: 'Bash', text: 'npm run build' } }),
    S({ name: 'member-api', ownerId: 'u-member', machineId: 'm-mem-lap', account: 'dev@company-b.example', cwd: '/Users/hong/api',
      status: 'wait', seen: false, startedAt: ago(40), lastEventAt: ago(3), contextPct: 58, costUsd: 2.4,
      activity: { label: '알림', text: 'Claude needs your permission to use Bash' } }),
    S({ name: 'brand-site', ownerId: 'u-design', machineId: 'm-des', account: 'dev@company-c.example', cwd: '/Users/design/brand-site',
      status: 'done', startedAt: ago(60), lastEventAt: ago(6), contextPct: 41, costUsd: 1.1,
      activity: { label: '완료', text: '헤더 디자인을 정리했습니다.' } }),
  ];

  // ── 대화 기록 ───────────────────────────────────────────
  var logs = {};
  // 줄의 시각(at)은 다 만든 뒤 세션 시작~마지막 활동 사이에 고르게 나눠 붙인다(spreadTimes).
  function Log(id) {
    var lines = logs[id] = logs[id] || [];
    var api = {
      push: function (line) { line.seq = lines.length; lines.push(line); return api; },
      u: function (text) { return api.push({ role: 'user', text: text }); },
      a: function (text, _gap, extra) { return api.push(Object.assign({ role: 'assistant', text: text }, extra)); },
      tu: function (name, input, extra) {
        var summary = input.command || input.file_path || input.pattern || input.description || JSON.stringify(input);
        return api.push(Object.assign({ role: 'tool', toolName: name, toolInput: input, text: summary }, extra));
      },
      tr: function (name, text, extra) { return api.push(Object.assign({ role: 'tool', toolName: name, text: text }, extra)); },
    };
    return api;
  }
  function spreadTimes() {
    sessions.concat(otherSessions).forEach(function (s) {
      var lines = logs[s.id] || [];
      var start = Date.parse(s.startedAt) + 20000;
      var end = Date.parse(s.lastEventAt);
      lines.forEach(function (l, i) {
        l.at = iso(lines.length === 1 ? end : start + (end - start) * (i / (lines.length - 1)));
      });
    });
  }

  Log('demo-search-api', 45)
    .u('검색 결과 순위가 이상해요. 최신 글이 너무 아래로 밀립니다. 원인을 찾아서 고쳐 주세요.')
    .a('순위 계산 코드부터 살펴보겠습니다.')
    .tu('Grep', { pattern: 'recencyBoost', path: 'src' })
    .tr('Grep', 'src/rank/score.ts:42:  const recencyBoost = 0.02 * ageDays;')
    .tu('Read', { file_path: 'src/rank/score.ts' })
    .tr('Read', 'export function score(doc: Doc, q: Query): number {\n  const base = bm25(doc, q);\n  …')
    .a('원인을 찾았습니다. 최신성 가중치가 글이 오래될수록 커지는 방향으로 더해지고 있어서, 오래된 글이 오히려 점수를 더 받습니다.\n\n부호를 바로잡고, 날짜가 지날수록 천천히 줄어드는 감쇠 함수로 바꾸겠습니다.', 40)
    .tu('Edit', { file_path: 'src/rank/score.ts', old_string: 'const recencyBoost = 0.02 * ageDays;', new_string: 'const recencyBoost = Math.exp(-ageDays / 30);' })
    .tr('Edit', 'The file src/rank/score.ts has been updated.')
    .tu('Bash', { command: 'npm test -- rank', description: '순위 테스트 실행' })
    .tr('Bash', ' ✓ src/rank/score.test.ts (12 tests) 38ms\n\n Test Files  1 passed (1)\n      Tests  12 passed (12)')
    .a('순위 테스트 12개가 모두 통과했습니다. 최신 글이 위로 올라오는 것도 확인했습니다.')
    .u('좋아요. 스테이징 DB에도 새 인덱스를 반영해 주세요.', 120)
    .tu('Bash', { command: 'cat .env.staging' })
    .tr('Bash', 'DATABASE_URL=postgres://app:••••••••@db.staging.internal:5432/search\nSEARCH_API_KEY=••••••••', { masked: 2 })
    .a('스테이징 접속 정보를 확인했습니다. 비밀번호와 API 키는 이 컴퓨터에서 가린 뒤 보냈습니다. 이제 인덱스 마이그레이션을 실행하겠습니다.')
    .tu('Bash', { command: 'npm run migrate -- --env staging', description: '스테이징 DB에 인덱스 마이그레이션 적용' });

  Log('demo-blog-site', 21)
    .u('블로그 글 목록 페이지를 새로 만들어 줘. 글이 200개가 넘어서 한 번에 다 보이면 느려.')
    .a('지금 페이지 구성을 먼저 보겠습니다.')
    .tu('Glob', { pattern: 'src/pages/**/*.astro' })
    .tr('Glob', 'src/pages/index.astro\nsrc/pages/posts/[slug].astro\nsrc/pages/about.astro')
    .tu('Read', { file_path: 'src/pages/index.astro' })
    .tr('Read', '---\nimport { getCollection } from "astro:content";\nconst posts = await getCollection("blog");\n---')
    .a('지금은 글 전체를 한 페이지에 그리고 있습니다. 나눠 보여 주는 방법이 두 가지라 먼저 정해 주시면 좋겠습니다.\n\n1. 페이지 번호: 주소가 /posts/2처럼 나뉘어 검색 엔진에 유리합니다.\n2. 무한 스크롤: 휴대폰에서 넘기기 편하지만 특정 글 위치를 다시 찾기 어렵습니다.', 30)
    .tu('AskUserQuestion', { questions: [{ question: '글 목록을 어떻게 나눌까요?', options: [{ label: '페이지 번호' }, { label: '무한 스크롤' }] }] });

  Log('demo-data-pipeline', 13)
    .u('어제 날짜 데이터로 집계 파이프라인 한 번 돌려 주고, 실패하는 단계 있으면 알려 줘.')
    .a('어제 날짜 데이터로 실행하겠습니다.')
    .tu('Bash', { command: 'python -m pipeline.run --date 2026-11-13' })
    .tr('Bash', '[1/4] extract   … 12,480 rows\n[2/4] clean     … 12,311 rows (169 dropped)\n[3/4] aggregate …');

  Log('demo-drawing-review', 94)
    .u('도면 검토 결과를 PDF 리포트로 뽑는 기능을 마무리해 줘. 테스트도 다 돌려 주고.')
    .a('남은 작업을 확인하겠습니다.')
    .tu('Grep', { pattern: 'TODO\\(report\\)', path: 'src' })
    .tr('Grep', 'src/report/pdf.ts:18: // TODO(report): 표지에 검토 일자 넣기\nsrc/report/pdf.ts:77: // TODO(report): 지적 사항 요약 표')
    .a('남은 일은 두 가지입니다. 표지에 검토 일자를 넣고, 지적 사항 요약 표를 만들겠습니다.')
    .tu('Edit', { file_path: 'src/report/pdf.ts', old_string: '// TODO(report): 표지에 검토 일자 넣기', new_string: 'cover.date = formatDate(review.at);' })
    .tr('Edit', 'The file src/report/pdf.ts has been updated.')
    .tu('Write', { file_path: 'src/report/summary-table.ts', content: 'export function summaryTable(findings) { … }' })
    .tr('Write', 'File created successfully at: src/report/summary-table.ts')
    .tu('Bash', { command: 'npm test', description: '전체 테스트 실행' })
    .tr('Bash', ' ✓ test/report/pdf.test.ts (9 tests)\n ✓ test/report/summary-table.test.ts (6 tests)\n ✓ test/review/rules.test.ts (27 tests)\n…(출력이 길어 줄였습니다)', { truncated: true })
    .tu('Bash', { command: 'npm run report -- --sample 3', description: '예시 도면 3건으로 리포트 생성' })
    .tr('Bash', 'out/report-A-101.pdf (4 pages)\nout/report-A-102.pdf (3 pages)\nout/report-B-201.pdf (6 pages)')
    .a('PDF 리포트 기능을 마무리했습니다. 테스트 42개가 모두 통과했습니다.\n\n- 표지에 검토 일자가 들어갑니다.\n- 마지막 장에 지적 사항 요약 표가 붙습니다.\n- 예시 도면 3건으로 리포트를 뽑아 out/ 폴더에 두었습니다.', 50);

  Log('demo-homepage', 30)
    .u('메인 화면 첫 영역을 새 디자인 시안대로 바꿔 줘. 시안은 design/hero.png에 있어.')
    .tu('Read', { file_path: 'design/hero.png' })
    .tr('Read', '[image]')
    .a('시안을 확인했습니다. 제목을 왼쪽에 두고 오른쪽에 제품 사진을 놓는 2단 구성입니다. 지금 구성 요소를 고치겠습니다.')
    .tu('Edit', { file_path: 'src/components/Hero.astro', old_string: '<section class="hero">', new_string: '<section class="hero hero--split">' })
    .tr('Edit', 'The file src/components/Hero.astro has been updated.');

  (function () {
    var L = Log('demo-api-gateway', 127);
    var files = ['src/middleware/auth.ts', 'src/middleware/session.ts', 'src/routes/users.ts', 'src/routes/orders.ts',
      'src/routes/products.ts', 'src/lib/token.ts', 'src/lib/errors.ts', 'test/auth.test.ts'];
    L.u('인증 미들웨어를 정리하고 싶어요. 지금 라우트마다 토큰 검사를 복사해서 쓰고 있어서 하나로 모아 주세요. 기존 동작은 바뀌면 안 됩니다.')
      .a('라우트별 토큰 검사 코드를 먼저 모두 찾아보겠습니다.')
      .tu('Grep', { pattern: 'verifyToken\\(', path: 'src' })
      .tr('Grep', files.slice(2, 5).map(function (f, i) { return f + ':' + (12 + i * 7) + ':  const user = verifyToken(req.headers.authorization);'; }).join('\n'));
    // 대화가 긴 세션: "이전 대화 더 보기"와 검색을 눌러 볼 수 있게 라우트 30개를 하나씩 점검한 기록을 넣는다.
    var routes = ['accounts', 'addresses', 'admin', 'audit', 'billing', 'carts', 'categories', 'coupons', 'devices', 'exports',
      'files', 'health', 'imports', 'invoices', 'jobs', 'labels', 'locales', 'notes', 'notifications', 'payments',
      'plans', 'refunds', 'reports', 'reviews', 'roles', 'search', 'shipments', 'stock', 'teams', 'webhooks'];
    L.a('라우트가 많아서 하나씩 열어 토큰 검사 방식을 정리하겠습니다. 모두 ' + routes.length + '개입니다.');
    routes.forEach(function (r, i) {
      var f = 'src/routes/' + r + '.ts';
      L.tu('Read', { file_path: f })
        .tr('Read', '// ' + f + '\nimport { Router } from "express";\nconst router = Router();\n…')
        .tu('Grep', { pattern: 'verifyToken|requireUser', path: f })
        .tr('Grep', f + ':' + (10 + i) + ':  const user = ' + (i % 3 === 0 ? 'requireUser(req);' : 'verifyToken(req.headers.authorization);'))
        .a((i + 1) + '/' + routes.length + ' ' + r + ': ' + (i % 3 === 0 ? '이미 requireUser를 씁니다.' : 'verifyToken을 직접 부릅니다. 만료 응답은 ' + (i % 7 === 0 ? '403' : '401') + '입니다.'));
      if (i % 5 === 4) L.tu('Bash', { command: 'npm test -- --run ' + r }).tr('Bash', ' ✓ test/' + r + '.test.ts (' + (6 + i % 4) + ' tests)');
    });
    L.a('점검을 마쳤습니다. ' + routes.length + '개 가운데 10개는 이미 requireUser를 쓰고, 나머지 20개를 옮기면 됩니다. 만료 토큰에 403을 주는 곳이 몇 군데 있어 따로 표시해 두었습니다.', 60);
    files.forEach(function (f, i) {
      L.tu('Read', { file_path: f }).tr('Read', '// ' + f + '\nimport { Router } from "express";\n…');
      if (i % 2 === 1) L.a(f + '에서도 같은 검사 코드가 반복됩니다. 오류 응답 모양이 라우트마다 조금씩 달라서, 합칠 때 기존 응답을 그대로 지키도록 하겠습니다.', 30);
    });
    L.a('정리 방향은 이렇습니다.\n\n1. src/middleware/auth.ts 하나에 토큰 검사와 오류 응답을 모읍니다.\n2. 라우트는 requireUser()만 씁니다.\n3. 지금 응답 모양을 고정하는 테스트를 먼저 만들어 바뀌지 않았는지 확인합니다.', 60)
      .u('좋아요, 그렇게 진행해 주세요. 테스트부터요.', 90)
      .tu('Write', { file_path: 'test/auth.contract.test.ts', content: 'describe("인증 응답 모양", () => { … })' })
      .tr('Write', 'File created successfully at: test/auth.contract.test.ts')
      .tu('Bash', { command: 'npm test -- --run auth.contract' })
      .tr('Bash', ' ✓ test/auth.contract.test.ts (14 tests) 61ms');
    ['users', 'orders', 'products'].forEach(function (r) {
      L.tu('Edit', { file_path: 'src/routes/' + r + '.ts', old_string: 'const user = verifyToken(req.headers.authorization);', new_string: 'const user = requireUser(req);' })
        .tr('Edit', 'The file src/routes/' + r + '.ts has been updated.')
        .tu('Bash', { command: 'npm test -- --run ' + r })
        .tr('Bash', ' ✓ test/' + r + '.test.ts (' + (8 + r.length) + ' tests)')
        .a(r + ' 라우트를 옮겼습니다. 응답 모양 테스트도 그대로 통과합니다.', 20);
    });
    L.u('토큰이 만료됐을 때 401 대신 403이 나가는 곳이 있었던 것 같은데 확인해 줄래요?', 120)
      .tu('Grep', { pattern: 'status\\(403\\)', path: 'src' })
      .tr('Grep', 'src/routes/orders.ts:88:    return res.status(403).json({ error: "expired" });')
      .a('맞습니다. orders 라우트 한 곳만 만료된 토큰에 403을 돌려주고 있었습니다. 다른 라우트와 맞추려면 401로 바꿔야 하는데, 기존 동작을 바꾸는 일이라 따로 커밋으로 나누겠습니다.')
      .tu('Bash', { command: 'git add -A && git commit -m "인증 검사를 미들웨어 하나로 모음"' })
      .tr('Bash', '[refactor/auth-middleware 3f2a9c1] 인증 검사를 미들웨어 하나로 모음\n 6 files changed, 84 insertions(+), 131 deletions(-)')
      .tu('Bash', { command: 'npm test -- --run auth' });
  })();

  Log('demo-report-batch', 69)
    .u('지난달 주문 리포트를 거래처별로 다시 뽑아 주세요. 어제 수정한 환율 반영해서요.')
    .a('거래처 목록과 환율 표를 먼저 불러오겠습니다.')
    .tu('Bash', { command: 'python scripts/load_rates.py --month 2026-10' })
    .tr('Bash', 'loaded 31 daily rates (USD, EUR, JPY)')
    .tu('Bash', { command: 'python scripts/build_reports.py --month 2026-10 --by vendor' })
    .tr('Bash', 'vendor 1/58 … ok\nvendor 2/58 … ok\n…')
    .a('58개 거래처 가운데 23개까지 만들었습니다. 이어서 나머지를 만들겠습니다.', 300);

  Log('demo-mobile-app', 63)
    .u('안드로이드 릴리스 빌드 만들어 줘. 버전은 1.4.2로.')
    .tu('Edit', { file_path: 'app.json', old_string: '"version": "1.4.1"', new_string: '"version": "1.4.2"' })
    .tr('Edit', 'The file app.json has been updated.')
    .a('버전을 1.4.2로 올렸습니다. 릴리스 번들을 만들겠습니다. 몇 분 걸립니다.')
    .tu('Bash', { command: 'npx expo export --platform android' }, {});

  Log('demo-infra-scripts', 239)
    .u('백업 스크립트가 매일 새벽에 도는지 확인하고, 30일 지난 백업은 지우도록 바꿔 줘.')
    .tu('Read', { file_path: 'backup/run.sh' })
    .tr('Read', '#!/usr/bin/env bash\nset -euo pipefail\n…')
    .tu('Edit', { file_path: 'backup/run.sh', old_string: '# cleanup', new_string: 'find "$DEST" -mtime +30 -delete' })
    .tr('Edit', 'The file backup/run.sh has been updated.')
    .a('매일 04:00에 도는 것을 확인했고, 30일 지난 백업을 지우는 줄을 넣었습니다.', 60);

  Log('demo-design-system')
    .u('색 토큰을 v2 이름 규칙으로 바꿔 주세요. 기존 이름은 별칭으로 남겨 두고요.')
    .a('토큰 파일 구조를 먼저 살펴보겠습니다.')
    .tu('Read', { file_path: 'tokens/color.json' })
    .tr('Read', '{ "blue-500": "#1677FF", "teal-500": "#0E9488", … }')
    .a('v2 이름(primary, accent 등)으로 옮기고 옛 이름은 별칭으로 남기겠습니다.')
    .tu('Edit', { file_path: 'tokens/color.json' });
  Log('demo-landing-copy')
    .u('첫 화면 문구를 세 가지 안으로 써 주세요.')
    .a('세 가지 안을 썼습니다. 1안은 짧고, 2안은 기능 중심, 3안은 사례 중심입니다.');
  Log('demo-legacy-migration')
    .u('DB를 새 버전으로 올리는 마이그레이션을 준비해 주세요.')
    .tu('Bash', { command: 'npm run migrate -- --dry-run' })
    .tr('Bash', ' ✓ 7 migrations pending (dry run)')
    .a('마이그레이션 7건을 확인했습니다. 실제 적용은 점검 시간에 하시면 됩니다.');
  Log('demo-docs-cleanup')
    .u('오래된 문서를 정리해 주세요.')
    .a('쓰지 않는 문서 12개를 archive 폴더로 옮겼습니다.');
  Log('demo-member-notes')
    .u('노트 앱 빌드가 깨져요.')
    .tu('Bash', { command: 'npm run build' });
  Log('demo-member-api')
    .u('API 서버를 다시 띄워 주세요.')
    .a('서버를 다시 시작하려면 승인이 필요합니다.');
  Log('demo-brand-site')
    .u('헤더 디자인 정리해 주세요.')
    .a('헤더 디자인을 정리했습니다.');
  // drawing-review는 텔레그램에서 승인한 기록이 하나 있다(대화 줄 사이에 "텔레그램에서 「허용」으로 답했습니다").
  replyRecs['demo-drawing-review'] = [{ id: 'rr-0', at: ago(40), source: 'telegram', kind: 'permission', label: '허용' }];
  spreadTimes();

  // ── 화면용 조합 ────────────────────────────────────────
  function me() { return USERS.filter(function (u) { return u.id === meId; })[0]; }
  function userView(u) {
    return { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, consentedAt: u.consentedAt || null, deleteAt: u.deleteAt || null };
  }
  function machinesOf(uid) { return uid === meId ? machines : (OTHER_MACHINES[uid] || []); }
  function adminUserView(u) {
    return Object.assign(userView(u), {
      createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null, quotaMb: u.quotaMb, bytes: USAGE[u.id] || 0,
      machines: machinesOf(u.id).length, invited: !!u.invited,
    });
  }
  function sessionById(id) {
    return sessions.concat(otherSessions).filter(function (s) { return s.id === id; })[0] || null;
  }
  function visibleSessions(all) {
    var cutoff = Date.now() - settings.endHours * 60 * MIN;
    var alive = machines.map(function (m) { return m.id; });
    return sessions.filter(function (s) {
      if (all) return true;
      if (alive.indexOf(s.machineId) < 0 && !s.sharedBy) return false;
      return !(s.status === 'end' && s.endedAt && Date.parse(s.endedAt) < cutoff);
    });
  }
  // 원격 답장: 보낸 글 대기열(세션 id → 글 목록)과 요청 번호
  var queues = {};
  var reqSeq = 2;
  function newReqId() { reqSeq += 1; return 'req-' + reqSeq; }
  function machineOf(s) { return machines.filter(function (x) { return x.id === s.machineId; })[0] || null; }
  function versionAtLeast(v, min) {
    var a = String(v || '').split('-')[0].split('.').map(Number);
    var b = min.split('.').map(Number);
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var x = a[i] || 0;
      var y = b[i] || 0;
      if (isNaN(x)) return false;
      if (x !== y) return x > y;
    }
    return true;
  }
  // 계약의 canReply 규칙: 소유자 본인(데모 세션은 모두 내 것), 원격 답장 켜짐, 플러그인 0.2.0 이상, 종료·끊김 아님
  function canReplyOf(s) {
    if (s.sharedBy || s.ownerId) return false;
    var m = machineOf(s);
    return !!m && m.remoteReply && versionAtLeast(m.pluginVersion, '0.2.0') && s.status !== 'end' && s.status !== 'lost';
  }
  function sessionView(s) {
    var v = clone(s);
    v.canReply = canReplyOf(s);
    v.queuedMessages = (queues[s.id] || []).length;
    return v;
  }
  function snapshot(all) {
    var list = visibleSessions(all).slice().sort(function (a, b) { return Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt); });
    return { sessions: list.map(sessionView), machines: clone(machines), accounts: clone(accounts) };
  }

  // ── 가짜 실시간 스트림 ──────────────────────────────────
  var streams = [];
  function publish(msg) {
    var data = JSON.stringify(msg);
    // 내 대시보드 스트림에만 보낸다(관리자가 남의 대시보드를 보는 스트림·공개 링크 스트림에는 보내지 않는다).
    streams.slice().forEach(function (es) { if (!es._public && es._user === meId) es._message(data); });
    // 공개 링크 스트림에는 그 세션의 상태(public)와 새 줄(log)만, 세션 id 없이.
    if (msg.type === 'log' || msg.type === 'session') {
      var sid = msg.type === 'log' ? msg.sessionId : msg.session.id;
      streams.slice().forEach(function (es) {
        var link = es._public && publicLinks[es._public];
        if (!link || link.sessionId !== sid) return;
        es._message(JSON.stringify(msg.type === 'log' ? { type: 'log', lines: msg.lines } : { type: 'public', session: publicView(es._public) }));
      });
    }
  }
  function publishSession(s) { publish({ type: 'session', session: sessionView(s) }); }

  function FakeEventSource(url, opts) {
    this.url = new URL(String(url), location.href).href;
    this.withCredentials = !!(opts && opts.withCredentials);
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this._listeners = {};
    var self = this;
    setTimeout(function () {
      if (self.readyState === 2) return;
      var u = new URL(self.url);
      var pm = /^\/api\/public\/s\/([^/]+)\/stream$/.exec(u.pathname);
      if (pm) {
        self._public = decodeURIComponent(pm[1]);
        if (!publicView(self._public)) { self.readyState = 2; self._fire('error', new Event('error')); return; }
        self.readyState = 1;
        streams.push(self);
        self._fire('open', new Event('open'));
        self._message(JSON.stringify({ type: 'public', session: publicView(self._public) }));
        startWorld();
        return;
      }
      var want = u.searchParams.get('user');
      self._user = want || meId;
      var ok = u.pathname === '/api/stream' && loggedIn && me().status === 'active' && !me().deleteAt
        && (self._user === meId || me().role === 'admin');
      if (!ok) { self.readyState = 2; self._fire('error', new Event('error')); return; }
      self.readyState = 1;
      streams.push(self);
      self._fire('open', new Event('open'));
      self._message(JSON.stringify(Object.assign({ type: 'snapshot' }, snapshotFor(self._user, false))));
      startWorld();
    }, 180);
  }
  FakeEventSource.CONNECTING = 0;
  FakeEventSource.OPEN = 1;
  FakeEventSource.CLOSED = 2;
  FakeEventSource.prototype.CONNECTING = 0;
  FakeEventSource.prototype.OPEN = 1;
  FakeEventSource.prototype.CLOSED = 2;
  FakeEventSource.prototype.close = function () {
    this.readyState = 2;
    var i = streams.indexOf(this);
    if (i >= 0) streams.splice(i, 1);
  };
  FakeEventSource.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  FakeEventSource.prototype.removeEventListener = function (type, fn) {
    var l = this._listeners[type] || [];
    var i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };
  FakeEventSource.prototype.dispatchEvent = function (ev) { this._fire(ev.type, ev); return true; };
  FakeEventSource.prototype._fire = function (type, ev) {
    var self = this;
    var h = this['on' + type];
    if (typeof h === 'function') h.call(this, ev);
    (this._listeners[type] || []).slice().forEach(function (fn) { fn.call(self, ev); });
  };
  FakeEventSource.prototype._message = function (data) {
    if (this.readyState !== 1) return;
    this._fire('message', new MessageEvent('message', { data: data, origin: location.origin }));
  };
  window.EventSource = FakeEventSource;

  // ── 상태 변화 대본 ─────────────────────────────────────
  // 몇 초마다 한 걸음씩: 작업 중 → 끝남 → 다시 작업 중(data-pipeline), 작업 중 → 답변 기다림 → 다시 작업 중(homepage),
  // 둘이 동시에 빠지지 않게 엇갈려 두어 작업 중 세션이 늘 두 개 이상 남는다.
  // 대화 줄 추가, 한도 변화, 컴퓨터 신호. 대본을 다 돌면 처음부터 다시 돈다.
  function addLines(id, newLines) {
    var lines = logs[id] = logs[id] || [];
    var out = newLines.map(function (l) {
      var line = Object.assign({}, l, { at: nowIso(), seq: lines.length });
      lines.push(line);
      return line;
    });
    publish({ type: 'log', sessionId: id, lines: clone(out) });
  }
  function touch(id, patch) {
    var s = sessionById(id);
    if (!s) return null;
    Object.assign(s, patch, { lastEventAt: nowIso() });
    var m = machines.filter(function (x) { return x.id === s.machineId; })[0];
    if (m && m.online) m.lastSeenAt = nowIso();
    if (visibleSessions(false).indexOf(s) >= 0) publishSession(s);
    if (s.status === 'done' && (queues[id] || []).length) setTimeout(function () { deliverNext(id); }, 900);
    return s;
  }

  // ── 원격 답장 흉내 ─────────────────────────────────────
  var REPLIES = [
    '네, 확인했습니다. 말씀하신 내용대로 이어서 진행하겠습니다.',
    '알겠습니다. 그 부분을 먼저 살펴보고 바로 고치겠습니다.',
    '좋습니다. 방금 요청하신 대로 바꿔 두었습니다. 더 필요한 것이 있으면 알려 주세요.',
  ];
  var replyTurn = 0;
  /** 끝난 세션에 글 하나를 넘긴다: 사용자 줄 → 작업 중 → 잠시 뒤 답과 함께 끝남. */
  function deliver(id, text) {
    addLines(id, [{ role: 'user', text: text }]);
    touch(id, { status: 'run', seen: true, activity: { label: '웹에서 보낸 글', text: text.split('\n')[0].slice(0, 120) } });
    setTimeout(function () {
      var reply = REPLIES[replyTurn++ % REPLIES.length];
      addLines(id, [{ role: 'assistant', text: reply }]);
      touch(id, { status: 'done', activity: { label: '완료', text: reply } });
    }, 2600);
  }
  function deliverNext(id) {
    var q = queues[id] || [];
    var s = sessionById(id);
    if (!q.length || !s || s.status !== 'done') return;
    deliver(id, q.shift());
  }
  /** 승인·질문에 답한 뒤 이어지는 대화. */
  function afterAnswer(id, steps) {
    var t = 0;
    steps.forEach(function (st) {
      t += st.wait;
      setTimeout(function () {
        var s = sessionById(id);
        if (!s) return;
        if (st.lines) addLines(id, st.lines);
        if (st.patch) touch(id, st.patch);
      }, t);
    });
  }
  var BEHAVIOR_LABEL = { allow: '허용', allow_session: '이 세션 동안 허용', deny: '거부' };
  function tool(name, input, result) {
    var summary = input.command || input.file_path || input.pattern || '';
    var out = [{ role: 'tool', toolName: name, toolInput: input, text: summary }];
    if (result != null) out.push({ role: 'tool', toolName: name, text: result });
    return out;
  }
  function bump(email, five, seven) {
    var a = accounts.filter(function (x) { return x.email === email; })[0];
    if (!a) return;
    a.fiveHourPct = Math.min(99, a.fiveHourPct + five);
    a.sevenDayPct = Math.min(99, a.sevenDayPct + seven);
    a.at = nowIso();
    var h = a.history[a.history.length - 1];
    if (h) { h.sevenDayPct = a.sevenDayPct; h.at = a.at; }
    publish({ type: 'limits', account: clone(a) });
  }

  var hpEdits = ['src/components/Hero.astro', 'src/styles/hero.css', 'src/components/Nav.astro', 'src/pages/index.astro'];
  var gwSteps = [
    ['Bash', { command: 'npm test -- --run auth' }, ' ✓ test/auth.test.ts (23 tests) 112ms'],
    ['Edit', { file_path: 'src/lib/errors.ts' }, 'The file src/lib/errors.ts has been updated.'],
    ['Bash', { command: 'npm run lint' }, '✔ No problems found'],
    ['Read', { file_path: 'src/middleware/session.ts' }, '// src/middleware/session.ts\n…'],
  ];
  var dpRun = 0;
  var cycle = 0;

  var script = [
    function () {
      var f = hpEdits[cycle % hpEdits.length];
      addLines('demo-homepage', [{ role: 'assistant', text: f + '을(를) 시안에 맞게 고치겠습니다.' }].concat(tool('Edit', { file_path: f }, 'The file ' + f + ' has been updated.')));
      touch('demo-homepage', { activity: { label: 'Edit', text: f } });
    },
    function () {
      addLines('demo-data-pipeline', [
        { role: 'tool', toolName: 'Bash', text: '[3/4] aggregate … 1,204 groups\n[4/4] publish   … ok' },
        { role: 'assistant', text: '어제 데이터로 집계를 마쳤습니다. 네 단계 모두 성공했고, 정리 단계에서 빈 값이 있는 169줄을 뺐습니다.' },
      ]);
      touch('demo-data-pipeline', { status: 'done', activity: { label: '완료', text: '어제 데이터로 집계를 마쳤습니다. 네 단계 모두 성공했습니다.' } });
    },
    function () {
      var st = gwSteps[cycle % gwSteps.length];
      addLines('demo-api-gateway', tool(st[0], st[1], st[2]));
      touch('demo-api-gateway', { activity: { label: st[0], text: st[1].command || st[1].file_path } });
    },
    function () {
      dpRun += 1;
      var day = 12 - (dpRun % 5);
      var cmd = 'python -m pipeline.run --date 2026-11-' + (day < 10 ? '0' + day : day);
      addLines('demo-data-pipeline', [{ role: 'user', text: '좋아요. 11월 ' + day + '일 데이터로도 한 번 더 돌려 주세요.' }].concat(
        tool('Bash', { command: cmd }, '[1/4] extract   … ' + (11000 + dpRun * 137) + ' rows\n[2/4] clean     …')));
      touch('demo-data-pipeline', { status: 'run', activity: { label: 'Bash', text: cmd } });
    },
    function () { bump(ACC_A, 1, 0.4); bump(ACC_B, 2, 0.6); },
    function () {
      addLines('demo-homepage', tool('Bash', { command: 'npm run build' }));
      touch('demo-homepage', { status: 'wait', seen: false, activity: { label: '알림', text: 'Claude needs your permission to use Bash' },
        pending: { id: newReqId(), kind: 'permission', toolName: 'Bash', summary: 'npm run build', sessionAllow: null, at: nowIso(), more: 0 } });
    },
    function () {
      var st = gwSteps[(cycle + 2) % gwSteps.length];
      addLines('demo-api-gateway', [{ role: 'assistant', text: '확인했습니다. 다음 단계로 넘어가겠습니다.' }].concat(tool(st[0], st[1], st[2])));
      touch('demo-api-gateway', { activity: { label: st[0], text: st[1].command || st[1].file_path } });
    },
    function () {
      addLines('demo-homepage', [
        { role: 'tool', toolName: 'Bash', text: 'build complete in 3.4s · 18 pages' },
        { role: 'assistant', text: '빌드가 끝났습니다. 휴대폰 폭에서 사진이 제목 아래로 내려가는지 확인하겠습니다.' },
      ]);
      touch('demo-homepage', { status: 'run', pending: null, activity: { label: 'Bash', text: 'npm run build' } });
    },
    function () {
      machines.forEach(function (m) {
        if (!m.online) return;
        m.lastSeenAt = nowIso();
        publish({ type: 'machine', machine: clone(m) });
      });
      bump(ACC_A, 0, 0.3);
    },
  ];

  var worldTimer = null;
  var stepIndex = 0;
  function startWorld() {
    if (worldTimer) return;
    worldTimer = setInterval(function () {
      if (streams.length === 0) return;
      script[stepIndex]();
      stepIndex += 1;
      if (stepIndex >= script.length) { stepIndex = 0; cycle += 1; }
    }, 4000);
  }

  // ── 가짜 API ───────────────────────────────────────────
  function J(status, body) { return { status: status, body: body }; }
  var notFound = function () { return J(404, { error: 'not_found' }); };

  function guard(level) {
    if (!loggedIn) return J(401, { error: 'unauthorized' });
    var u = me();
    if (level !== 'any' && u.deleteAt) return J(403, { error: 'withdrawn' });
    if (level !== 'any' && u.status !== 'active') return J(403, { error: u.status });
    if (level === 'admin' && u.role !== 'admin') return J(403, { error: 'forbidden' });
    return null;
  }
  function isInt(v, min, max) { return typeof v === 'number' && Math.floor(v) === v && v >= min && v <= max; }
  function normalizeUserCode(raw) {
    var s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4) : '';
  }
  var usedCodes = {};

  function route(method, url, body) {
    var p = url.pathname;
    var m;
    var g;

    if (p === '/auth/logout' && method === 'POST') { loggedIn = false; return J(200, { ok: true }); }

    if (p === '/api/me' && method === 'GET') {
      if ((g = guard('any'))) return g;
      var u = me();
      var res = { user: userView(u) };
      if (u.role === 'admin' && u.status === 'active') {
        res.pendingCount = USERS.filter(function (x) { return x.status === 'pending'; }).length;
      }
      return J(200, res);
    }

    if (p === '/api/sessions' && method === 'GET') {
      if ((g = guard('active'))) return g;
      var uq = url.searchParams.get('user');
      if (uq && uq !== meId && me().role !== 'admin') return J(403, { error: 'forbidden' });
      return J(200, snapshotFor(uq || meId, url.searchParams.get('history') === '1'));
    }

    if ((m = /^\/api\/sessions\/([^/]+)\/log$/.exec(p)) && method === 'GET') {
      if ((g = guard('active'))) return g;
      var id = decodeURIComponent(m[1]);
      if (!sessionById(id)) return notFound();
      // 페이지 단위 조회: 쿼리 없음 = 최근 limit줄, before / after / around 중 하나.
      var q = url.searchParams;
      var keys = ['before', 'after', 'around'].filter(function (k) { return q.has(k); });
      if (keys.length > 1) return J(400, { error: 'invalid_query' });
      var limit = q.has('limit') ? Number(q.get('limit')) : 100;
      if (!Number.isInteger(limit) || limit < 1) limit = 100;
      limit = Math.min(limit, 500);
      var all = logs[id] || [];
      var picked;
      if (keys.length === 0) {
        picked = all.slice(-limit);
      } else {
        var at = Number(q.get(keys[0]));
        if (!Number.isInteger(at)) return J(400, { error: 'invalid_' + keys[0] });
        if (keys[0] === 'after') picked = all.filter(function (l) { return l.seq > at; }).slice(0, limit);
        else if (keys[0] === 'before') picked = all.filter(function (l) { return l.seq < at; }).slice(-limit);
        else {
          var half = Math.floor(limit / 2);
          var idx = Math.max(0, Math.min(all.length - limit, at - half));
          picked = all.slice(idx, idx + limit);
        }
      }
      return J(200, {
        lines: clone(picked),
        total: all.length,
        hasMoreBefore: picked.length > 0 ? picked[0].seq > 0 : false,
        hasMoreAfter: picked.length > 0 ? picked[picked.length - 1].seq < all.length - 1 : false,
      });
    }

    if ((m = /^\/api\/sessions\/([^/]+)\/search$/.exec(p)) && method === 'GET') {
      if ((g = guard('active'))) return g;
      var sid = decodeURIComponent(m[1]);
      if (!sessionById(sid)) return notFound();
      var needle = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (needle.length < 2) return J(400, { error: 'query_too_short' });
      var hits = (logs[sid] || []).filter(function (l) {
        return (l.text || '').toLowerCase().indexOf(needle) >= 0 || (l.toolName || '').toLowerCase().indexOf(needle) >= 0;
      }).reverse();
      var max = Math.min(Number(url.searchParams.get('limit')) || 50, 50);
      return J(200, {
        total: hits.length,
        hits: hits.slice(0, max).map(function (l) {
          var hit = { seq: l.seq, role: l.role, at: l.at, snippet: searchSnippet(l.text || '', needle) };
          if (l.toolName) hit.toolName = l.toolName;
          return hit;
        }),
      });
    }

    // 종료·끊김 세션만 지운다(그 밖은 409). 지우면 대화도 함께 없애고 removed를 알린다.
    // 세션별 텔레그램 알림 스위치(소유자만)
    if ((m = /^\/api\/sessions\/([^/]+)$/.exec(p)) && method === 'PATCH') {
      if ((g = guard('active'))) return g;
      var ts = sessionById(decodeURIComponent(m[1]));
      if (!ts) return notFound();
      if (ts.sharedBy) return J(403, { error: 'forbidden' });
      if (!body || typeof body.telegram !== 'boolean') return J(400, { error: 'invalid_body' });
      ts.telegram = body.telegram;
      publishSession(ts);
      return J(200, { session: sessionView(ts) });
    }

    if ((m = /^\/api\/sessions\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      if ((g = guard('active'))) return g;
      var did = decodeURIComponent(m[1]);
      var ds = sessionById(did);
      if (!ds || ds.sharedBy || ds.ownerId) return notFound();
      if (ds.status !== 'end' && ds.status !== 'lost') return J(409, { error: 'session_active' });
      sessions = sessions.filter(function (x) { return x.id !== did; });
      delete logs[did];
      publish({ type: 'removed', sessionIds: [did] });
      return J(200, { ok: true });
    }

    if ((m = /^\/api\/sessions\/([^/]+)\/seen$/.exec(p)) && method === 'POST') {
      if ((g = guard('active'))) return g;
      var s = sessionById(decodeURIComponent(m[1]));
      if (!s) return notFound();
      if (!s.seen) { s.seen = true; publishSession(s); }
      return J(200, { session: clone(s) });
    }

    if (p === '/api/settings') {
      if ((g = guard('active'))) return g;
      if (method === 'GET') return J(200, clone(settings));
      if (method === 'PUT') {
        var b = body || {};
        var limits = { lostMinutes: [1, 1440], endHours: [0, 8760], keepChatDays: [0, 3650], keepUsageDays: [0, 3650] };
        for (var k in b) {
          if (!limits[k] || !isInt(b[k], limits[k][0], limits[k][1])) return J(400, { error: 'invalid_body' });
        }
        var endChanged = b.endHours !== undefined && b.endHours !== settings.endHours;
        Object.assign(settings, b);
        if (endChanged) publish(Object.assign({ type: 'snapshot' }, snapshot(false)));
        return J(200, clone(settings));
      }
    }

    // ── 알림(텔레그램) ──
    if (p === '/api/notify' && method === 'GET') {
      if ((g = guard('active'))) return g;
      return J(200, notifyView());
    }
    if (p === '/api/notify/settings' && method === 'PUT') {
      if ((g = guard('active'))) return g;
      var ns = body || {};
      var okBody = ['wait', 'done', 'lost', 'limit'].every(function (k) { return typeof ns[k] === 'boolean'; }) && isInt(ns.limitPct, 50, 100);
      if (!okBody) return J(400, { error: 'invalid_body' });
      notify.settings = { wait: ns.wait, done: ns.done, lost: ns.lost, limit: ns.limit, limitPct: ns.limitPct };
      return J(200, notifyView());
    }
    if (p === '/api/notify/telegram/link' && method === 'POST') {
      if ((g = guard('active'))) return g;
      if (!adminTg.configured) return J(409, { error: 'telegram_unavailable' });
      var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      var lc = '';
      for (var i = 0; i < 8; i++) lc += abc.charAt(Math.floor(Math.random() * abc.length));
      // 데모: 사람이 텔레그램에서 "시작"을 누른 셈 치고 몇 초 뒤 연결된다. 새로 받으면 옛 코드는 무효.
      if (linkTimer) clearTimeout(linkTimer);
      linkTimer = setTimeout(function () {
        linkTimer = null;
        if (!adminTg.configured) return;
        if (!notify.linked) adminTg.linkedUsers += 1;
        notify.linked = true;
        notify.linkedName = '@demo_user';
        notify.linkedAt = nowIso();
      }, 7000);
      return J(200, { code: lc, url: 'https://t.me/' + adminTg.botUsername + '?start=' + lc, expiresAt: iso(Date.now() + 10 * MIN) });
    }
    if (p === '/api/notify/telegram' && method === 'DELETE') {
      if ((g = guard('active'))) return g;
      if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
      if (notify.linked) adminTg.linkedUsers = Math.max(0, adminTg.linkedUsers - 1);
      notify.linked = false;
      notify.linkedName = null;
      notify.linkedAt = null;
      return J(200, notifyView());
    }
    if (p === '/api/notify/telegram/test' && method === 'POST') {
      if ((g = guard('active'))) return g;
      if (!adminTg.configured) return J(409, { error: 'telegram_unavailable' });
      if (!notify.linked) return J(409, { error: 'not_linked' });
      return J(200, { ok: true });
    }

    // ── 관리자: 텔레그램 봇 ──
    if (p === '/api/admin/telegram') {
      if ((g = guard('admin'))) return g;
      if (method === 'GET') return J(200, clone(adminTg));
      if (method === 'PUT') {
        var tok = body && typeof body.token === 'string' ? body.token.trim() : '';
        if (!/^[0-9]{5,}:[A-Za-z0-9_-]{30,}$/.test(tok)) return J(400, { error: 'invalid_token' });
        // 데모: 숫자 부분이 0으로 시작하면 텔레그램이 거절한 셈 친다.
        if (tok.charAt(0) === '0') return J(400, { error: 'invalid_token' });
        Object.assign(adminTg, { configured: true, botUsername: DEMO_BOT, tokenHint: tok.slice(-4), updatedAt: nowIso(), polling: 'ok', lastError: null });
        return J(200, clone(adminTg));
      }
      if (method === 'DELETE') {
        Object.assign(adminTg, { configured: false, botUsername: null, tokenHint: null, updatedAt: nowIso(), polling: 'off', lastError: null });
        return J(200, clone(adminTg));
      }
    }

    if ((m = /^\/api\/accounts\/([^/]+)$/.exec(p)) && method === 'PATCH') {
      if ((g = guard('active'))) return g;
      var email = decodeURIComponent(m[1]);
      var a = accounts.filter(function (x) { return x.email === email; })[0];
      if (!a) return notFound();
      var pb = body || {};
      if (pb.alias !== undefined) a.alias = typeof pb.alias === 'string' && pb.alias.trim() ? pb.alias.trim().slice(0, 60) : null;
      if (typeof pb.hidden === 'boolean') a.hidden = pb.hidden;
      publish({ type: 'limits', account: clone(a) });
      return J(200, clone(a));
    }

    // 원격 답장: 승인·질문에 답하거나 글을 보낸다(계약의 ReplyRequest). 끝난 요청이면 409 no_pending.
    if ((m = /^\/api\/sessions\/([^/]+)\/reply$/.exec(p)) && method === 'POST') {
      if ((g = guard('active'))) return g;
      var rid = decodeURIComponent(m[1]);
      var rs = sessionById(rid);
      if (!rs) return notFound();
      var rb = body || {};
      if (!canReplyOf(rs)) return J(409, { error: 'reply_disabled' });
      if (rb.type === 'permission' || rb.type === 'answer') {
        var pd = rs.pending;
        if (!pd || pd.id !== rb.requestId) return J(409, { error: 'no_pending' });
        if (rb.type === 'permission' && !BEHAVIOR_LABEL[rb.behavior]) return J(400, { error: 'invalid_body' });
        if (rb.type === 'answer' && (!rb.answers || typeof rb.answers !== 'object')) return J(400, { error: 'invalid_body' });
        var msg = typeof rb.message === 'string' ? rb.message.trim().slice(0, 4000) : '';
        var lines = [];
        var steps;
        if (rb.type === 'permission' && rb.behavior === 'deny') {
          recordReply(rid, 'permission', '거부');
          lines.push({ role: 'tool', toolName: pd.toolName, text: "The user doesn't want to proceed with this tool use. The tool use was rejected." });
          if (msg) lines.push({ role: 'user', text: msg });
          var after = msg ? '알겠습니다. 실행하지 않고 말씀하신 대로 바꿔서 진행하겠습니다.' : '알겠습니다. 그 명령은 실행하지 않겠습니다. 다른 방법이 필요하면 알려 주세요.';
          steps = [{ wait: 2200, lines: [{ role: 'assistant', text: after }], patch: { status: 'done', activity: { label: '완료', text: after } } }];
        } else if (rb.type === 'permission') {
          recordReply(rid, 'permission', BEHAVIOR_LABEL[rb.behavior]);
          var ok = pd.summary.indexOf('migrate') >= 0 ? ' ✓ 2 migrations applied (staging) in 1.8s' : '완료 · 0.' + (3 + (reqSeq % 6)) + '초';
          var fin = pd.summary.indexOf('migrate') >= 0
            ? '스테이징 DB에 인덱스 마이그레이션 2건을 적용했습니다. 검색 응답 시간도 다시 확인해 두었습니다.'
            : '실행을 마쳤습니다. 결과를 확인하고 다음 단계로 넘어가겠습니다.';
          steps = [
            { wait: 1800, lines: [{ role: 'tool', toolName: pd.toolName, text: ok }] },
            { wait: 2000, lines: [{ role: 'assistant', text: fin }], patch: { status: 'done', activity: { label: '완료', text: fin } } },
          ];
        } else {
          var pairs = Object.keys(rb.answers).map(function (k) { return '"' + k + '"="' + String(rb.answers[k]).slice(0, 4000) + '"'; });
          var first = String(rb.answers[Object.keys(rb.answers)[0]] || '');
          recordReply(rid, 'answer', Object.keys(rb.answers).map(function (k) { return String(rb.answers[k]); }).join(' / ').slice(0, 200));
          lines.push({ role: 'tool', toolName: pd.toolName, text: 'User has answered your questions: ' + pairs.join(', ') + '.' });
          var plan = '「' + first.slice(0, 60) + '」(으)로 정하셨군요. 그 방식으로 글 목록 페이지를 만들겠습니다.';
          steps = [
            { wait: 1600, lines: [{ role: 'assistant', text: plan }] },
            { wait: 2400, lines: [{ role: 'assistant', text: '글 목록 페이지를 만들었습니다. 한 쪽에 20개씩 보이고, 휴대폰에서도 확인했습니다.' }],
              patch: { status: 'done', activity: { label: '완료', text: '글 목록 페이지를 만들었습니다.' } } },
          ];
        }
        rs.pending = null;
        addLines(rid, lines);
        touch(rid, { status: 'run', seen: true, pending: null, activity: { label: pd.toolName, text: pd.summary } });
        afterAnswer(rid, steps);
        return J(200, { ok: true, queued: false });
      }
      if (rb.type === 'message') {
        var text = typeof rb.text === 'string' ? rb.text.trim() : '';
        if (!text || text.length > 4000) return J(400, { error: 'invalid_body' });
        recordReply(rid, 'message', text.slice(0, 200));
        if (rs.status === 'done') { deliver(rid, text); return J(200, { ok: true, queued: false }); }
        // 작업 중·답 기다림·한도 초과: 쌓아 두었다가 작업이 끝나면 넘긴다.
        (queues[rid] = queues[rid] || []).push(text);
        publishSession(rs);
        // 데모에서는 오래 기다리지 않게, 끝나지 않는 세션도 잠시 뒤 작업을 끝낸 것으로 친다.
        setTimeout(function () {
          var cur = sessionById(rid);
          if (cur && (queues[rid] || []).length && cur.status === 'run') touch(rid, { status: 'done', activity: { label: '완료', text: '하던 작업을 마쳤습니다.' } });
        }, 9000);
        return J(200, { ok: true, queued: true });
      }
      return J(400, { error: 'invalid_body' });
    }

    // 컴퓨터별 원격 답장 스위치. 바뀐 컴퓨터와 그 세션들(canReply)을 다시 알린다.
    if ((m = /^\/api\/machines\/([^/]+)$/.exec(p)) && method === 'PATCH') {
      if ((g = guard('active'))) return g;
      var pid = decodeURIComponent(m[1]);
      var pm = machines.filter(function (x) { return x.id === pid; })[0];
      if (!pm) return notFound();
      if (!body || typeof body.remoteReply !== 'boolean') return J(400, { error: 'invalid_body' });
      pm.remoteReply = body.remoteReply;
      publish({ type: 'machine', machine: clone(pm) });
      sessions.forEach(function (x) { if (x.machineId === pid && visibleSessions(false).indexOf(x) >= 0) publishSession(x); });
      return J(200, clone(pm));
    }

    if ((m = /^\/api\/machines\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      if ((g = guard('active'))) return g;
      var mid = decodeURIComponent(m[1]);
      var before = machines.length;
      machines = machines.filter(function (x) { return x.id !== mid; });
      if (machines.length === before) return notFound();
      publish(Object.assign({ type: 'snapshot' }, snapshot(false)));
      return J(200, { ok: true });
    }

    if (p === '/api/admin/users' && method === 'GET') {
      if ((g = guard('admin'))) return g;
      var order = USERS.slice().sort(function (x, y) {
        return (y.status === 'pending') - (x.status === 'pending') || Date.parse(y.createdAt) - Date.parse(x.createdAt);
      });
      return J(200, { users: order.map(adminUserView) });
    }

    if ((m = /^\/api\/admin\/users\/([^/]+)\/(approve|suspend)$/.exec(p)) && method === 'POST') {
      if ((g = guard('admin'))) return g;
      var uid = decodeURIComponent(m[1]);
      var target = USERS.filter(function (x) { return x.id === uid; })[0];
      if (!target) return notFound();
      if (m[2] === 'suspend' && uid === meId) return J(400, { error: 'cannot_suspend_self' });
      target.status = m[2] === 'approve' ? 'active' : 'suspended';
      return J(200, { user: clone(target) });
    }

    // ══ 3차 ═══════════════════════════════════════════════
    // 웹·텔레그램 답 기록
    if ((m = /^\/api\/sessions\/([^/]+)\/replies$/.exec(p)) && method === 'GET') {
      if ((g = guard('active'))) return g;
      var rpid = decodeURIComponent(m[1]);
      if (!sessionById(rpid)) return notFound();
      return J(200, { replies: clone((replyRecs[rpid] || []).slice(-200)) });
    }

    // 공유: 만들기·목록(소유자만), 취소
    if ((m = /^\/api\/sessions\/([^/]+)\/shares$/.exec(p))) {
      if ((g = guard('active'))) return g;
      var shid = decodeURIComponent(m[1]);
      var shs = sessionById(shid);
      if (!shs || shs.sharedBy || shs.ownerId) return notFound();
      var list = shares[shid] = shares[shid] || [];
      if (method === 'GET') return J(200, { shares: clone(list) });
      if (method === 'POST') {
        var sb = body || {};
        shareSeq += 1;
        var created = { id: 'sh-' + shareSeq, kind: sb.kind, url: null, email: null, expiresAt: null, createdAt: nowIso() };
        if (sb.kind === 'link') {
          var hours = { '1h': 1, '1d': 24, '7d': 24 * 7, never: 0 }[sb.expiresIn];
          if (hours === undefined) return J(400, { error: 'invalid_body' });
          created.expiresAt = hours ? iso(Date.now() + hours * 60 * MIN) : null;
          var token = 'demo' + shareSeq + '_' + shs.name.replace(/[^A-Za-z0-9-]/g, '');
          publicLinks[token] = { sessionId: shid, shareId: created.id, expiresAt: created.expiresAt };
          list.unshift(created);
          // 주소는 만들 때 한 번만 내려 준다(데모에서는 이 데모 페이지 안의 공개 보기 주소).
          var out = clone(created);
          out.url = new URL('app.html?view=' + encodeURIComponent('/s/' + token), BASE).href;
          return J(200, out);
        }
        if (sb.kind === 'user') {
          var em = String(sb.email || '').trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return J(400, { error: 'invalid_body' });
          if (em === me().email) return J(409, { error: 'self' });
          var to = USERS.filter(function (x) { return x.email === em && !x.invited && !x.deleteAt; })[0];
          if (!to) return J(409, { error: 'user_not_found' });
          created.email = em;
          list.unshift(created);
          return J(200, clone(created));
        }
        return J(400, { error: 'invalid_body' });
      }
    }
    if ((m = /^\/api\/shares\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      if ((g = guard('active'))) return g;
      var del = decodeURIComponent(m[1]);
      var found = false;
      Object.keys(shares).forEach(function (k) {
        var before2 = shares[k].length;
        shares[k] = shares[k].filter(function (x) { return x.id !== del; });
        if (shares[k].length !== before2) found = true;
      });
      Object.keys(publicLinks).forEach(function (t) {
        if (publicLinks[t].shareId === del) { delete publicLinks[t]; revokedTokens[t] = true; }
      });
      return found ? J(200, { ok: true }) : notFound();
    }

    // 공개 링크(로그인 없이, 토큰으로만)
    if ((m = /^\/api\/public\/s\/([^/]+)$/.exec(p)) && method === 'GET') {
      var pv = publicView(decodeURIComponent(m[1]));
      return pv ? J(200, pv) : notFound();
    }
    if ((m = /^\/api\/public\/s\/([^/]+)\/log$/.exec(p)) && method === 'GET') {
      var ptoken = decodeURIComponent(m[1]);
      if (!publicView(ptoken)) return notFound();
      var pg = pageOf(logs[publicLinks[ptoken].sessionId] || [], url.searchParams);
      return pg ? J(200, pg) : J(400, { error: 'invalid_query' });
    }

    // 계정: 동의·탈퇴·복구·저장 용량
    if (p === '/api/me/consent' && method === 'POST') {
      if ((g = guard('any'))) return g;
      var cu = me();
      if (!cu.consentedAt) cu.consentedAt = nowIso();
      return J(200, { user: userView(cu) });
    }
    if (p === '/api/me/withdraw' && method === 'POST') {
      if ((g = guard('active'))) return g;
      var wu = me();
      wu.deleteAt = iso(Date.now() + 7 * DAY * MIN);
      streams.slice().forEach(function (es) { if (!es._public) es.close(); });
      return J(200, { user: userView(wu) });
    }
    if (p === '/api/me/restore' && method === 'POST') {
      if ((g = guard('any'))) return g;
      var ru = me();
      if (ru.deleteAt && Date.parse(ru.deleteAt) <= Date.now()) return J(409, { error: 'expired' });
      ru.deleteAt = null;
      return J(200, { user: userView(ru) });
    }
    if (p === '/api/me/storage' && method === 'GET') {
      if ((g = guard('active'))) return g;
      var su = me();
      return J(200, { bytes: USAGE[su.id] || 0, quotaMb: su.quotaMb, trimmedAt: su.id === 'u-member' ? ago(60 * 20) : null });
    }

    // 웹 푸시(데모 브라우저는 지원하지 않는다. 목록·해제만 흉내 낸다)
    if (p === '/api/push/key' && method === 'GET') {
      if ((g = guard('active'))) return g;
      return J(200, { publicKey: 'BDemoKeyOnlyForTheMockupDoesNotWork' });
    }
    if (p === '/api/push/subscriptions' && method === 'GET') {
      if ((g = guard('active'))) return g;
      return J(200, { subscriptions: clone(pushSubs) });
    }
    if (p === '/api/push/subscribe') {
      if ((g = guard('active'))) return g;
      var ep = body && typeof body.endpoint === 'string' ? body.endpoint : '';
      if (!ep) return J(400, { error: 'invalid_body' });
      pushSubs = pushSubs.filter(function (x) { return x.endpoint !== ep; });
      if (method === 'POST') pushSubs.push({ endpoint: ep, label: body.label || null, createdAt: nowIso() });
      return J(200, { ok: true });
    }
    if (p === '/api/push/test' && method === 'POST') {
      if ((g = guard('active'))) return g;
      var tep = body && body.endpoint;
      return pushSubs.some(function (x) { return x.endpoint === tep; }) ? J(200, { ok: true }) : notFound();
    }

    // 관리자: 사용자 추가·바꾸기·복구·즉시 삭제
    if (p === '/api/admin/users' && method === 'POST') {
      if ((g = guard('admin'))) return g;
      var ne = String((body && body.email) || '').trim().toLowerCase();
      var nr = body && body.role;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ne) || (nr !== 'admin' && nr !== 'user')) return J(400, { error: 'invalid_body' });
      if (USERS.some(function (x) { return x.email === ne; })) return J(409, { error: 'exists' });
      var nu = { id: 'u-add-' + (USERS.length + 1), email: ne, name: null, role: nr, status: 'active', createdAt: nowIso(),
        consentedAt: null, deleteAt: null, lastLoginAt: null, quotaMb: 1024, invited: true };
      USERS.push(nu);
      USAGE[nu.id] = 0;
      return J(200, adminUserView(nu));
    }
    if ((m = /^\/api\/admin\/users\/([^/]+)$/.exec(p)) && (method === 'PATCH' || method === 'DELETE')) {
      if ((g = guard('admin'))) return g;
      var aid = decodeURIComponent(m[1]);
      var au = USERS.filter(function (x) { return x.id === aid; })[0];
      if (!au) return notFound();
      if (method === 'DELETE') {
        if (aid === meId) return J(400, { error: 'self' });
        USERS = USERS.filter(function (x) { return x.id !== aid; });
        delete OTHER_MACHINES[aid];
        otherSessions = otherSessions.filter(function (x) { return x.ownerId !== aid; });
        return J(200, { ok: true });
      }
      var pb2 = body || {};
      if (pb2.role !== undefined) {
        if (pb2.role !== 'admin' && pb2.role !== 'user') return J(400, { error: 'invalid_body' });
        if (aid === meId && pb2.role !== 'admin') return J(400, { error: 'self' });
        au.role = pb2.role;
      }
      if (pb2.quotaMb !== undefined) {
        if (!isInt(pb2.quotaMb, 0, 1000000)) return J(400, { error: 'invalid_body' });
        au.quotaMb = pb2.quotaMb;
      }
      return J(200, adminUserView(au));
    }
    if ((m = /^\/api\/admin\/users\/([^/]+)\/restore$/.exec(p)) && method === 'POST') {
      if ((g = guard('admin'))) return g;
      var rsu = USERS.filter(function (x) { return x.id === decodeURIComponent(m[1]); })[0];
      if (!rsu) return notFound();
      rsu.deleteAt = null;
      return J(200, adminUserView(rsu));
    }

    // 관리자: 모든 컴퓨터
    if (p === '/api/admin/machines' && method === 'GET') {
      if ((g = guard('admin'))) return g;
      var all2 = machines.map(function (x) {
        return Object.assign(clone(x), { ownerId: meId, ownerEmail: me().email, account: ACC_A });
      });
      Object.keys(OTHER_MACHINES).forEach(function (uid) {
        var owner = USERS.filter(function (x) { return x.id === uid; })[0];
        if (!owner) return;
        OTHER_MACHINES[uid].forEach(function (x) {
          all2.push(Object.assign(clone(x), { ownerId: uid, ownerEmail: owner.email, account: OTHER_ACCOUNTS[uid] || null }));
        });
      });
      return J(200, { machines: all2 });
    }
    if ((m = /^\/api\/admin\/machines\/([^/]+)$/.exec(p)) && (method === 'PATCH' || method === 'DELETE')) {
      if ((g = guard('admin'))) return g;
      var amid = decodeURIComponent(m[1]);
      var mine = machines.filter(function (x) { return x.id === amid; })[0];
      var ownerUid = mine ? meId : Object.keys(OTHER_MACHINES).filter(function (uid) {
        return OTHER_MACHINES[uid].some(function (x) { return x.id === amid; });
      })[0];
      if (!ownerUid) return notFound();
      var am = mine || OTHER_MACHINES[ownerUid].filter(function (x) { return x.id === amid; })[0];
      var ownerU = USERS.filter(function (x) { return x.id === ownerUid; })[0];
      if (method === 'DELETE') {
        if (mine) {
          machines = machines.filter(function (x) { return x.id !== amid; });
          publish(Object.assign({ type: 'snapshot' }, snapshot(false)));
        } else {
          OTHER_MACHINES[ownerUid] = OTHER_MACHINES[ownerUid].filter(function (x) { return x.id !== amid; });
        }
        return J(200, { ok: true });
      }
      if (!body || typeof body.remoteReply !== 'boolean') return J(400, { error: 'invalid_body' });
      am.remoteReply = body.remoteReply;
      if (mine) {
        publish({ type: 'machine', machine: clone(am) });
        sessions.forEach(function (x) { if (x.machineId === amid && visibleSessions(false).indexOf(x) >= 0) publishSession(x); });
      }
      return J(200, Object.assign(clone(am), { ownerId: ownerUid, ownerEmail: ownerU ? ownerU.email : '', account: mine ? ACC_A : (OTHER_ACCOUNTS[ownerUid] || null) }));
    }

    // 관리자: 저장 용량
    if (p === '/api/admin/storage' && method === 'GET') {
      if ((g = guard('admin'))) return g;
      var users2 = USERS.filter(function (x) { return !x.invited; }).map(function (x) {
        return { id: x.id, email: x.email, bytes: USAGE[x.id] || 0, quotaMb: x.quotaMb };
      });
      var chat = users2.reduce(function (a, x) { return a + x.bytes; }, 0);
      var usage = 3 * MB;
      var other = 3 * MB;
      return J(200, {
        totalBytes: chat + usage + other, chatBytes: chat, usageBytes: usage, otherBytes: other,
        diskFreeBytes: 29 * 1024 * MB, users: users2,
      });
    }

    if (p === '/api/device/lookup' && method === 'GET') {
      if ((g = guard('active'))) return g;
      var code = normalizeUserCode(url.searchParams.get('code'));
      if (!code || usedCodes[code]) return notFound();
      return J(200, { userCode: code, machineName: '노트북', os: 'macOS 15' });
    }

    if (p === '/api/device/approve' && method === 'POST') {
      if ((g = guard('active'))) return g;
      var c = normalizeUserCode(body && body.userCode);
      if (!c || usedCodes[c]) return notFound();
      usedCodes[c] = true;
      var nm = { id: 'm-new-' + c.replace('-', '').toLowerCase(), name: '노트북', os: 'macOS 15', pluginVersion: PLUGIN_VER, lastSeenAt: nowIso(), online: true, remoteReply: true };
      machines.push(nm);
      publish({ type: 'machine', machine: clone(nm) });
      return J(200, { ok: true, machineName: nm.name });
    }

    // 확인 화면의 "거부"(서버에 새로 생기는 API). 거부한 코드는 다시 쓸 수 없다.
    if (p === '/api/device/deny' && method === 'POST') {
      if ((g = guard('active'))) return g;
      var dc = normalizeUserCode(body && body.userCode);
      if (!dc || usedCodes[dc]) return notFound();
      usedCodes[dc] = true;
      return J(200, { ok: true });
    }

    return notFound();
  }

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var isReq = typeof Request !== 'undefined' && input instanceof Request;
    var url = new URL(isReq ? input.url : String(input), location.href);
    var handled = url.origin === location.origin && (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/auth/') === 0);
    if (!handled) return realFetch ? realFetch(input, init) : Promise.reject(new TypeError('fetch unavailable'));
    var method = String((init && init.method) || (isReq ? input.method : 'GET')).toUpperCase();
    var raw = init && typeof init.body === 'string' ? init.body : null;
    var body;
    if (raw) { try { body = JSON.parse(raw); } catch (e) { body = undefined; } }
    var delay = 80 + Math.floor(Math.random() * 180);
    return new Promise(function (resolve) {
      setTimeout(function () {
        var r = route(method, url, body);
        resolve(new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8' } }));
      }, delay);
    });
  };

  // ── 바깥으로 나가는 링크 가로채기 ─────────────────────
  // 로그인 버튼(/auth/google)은 구글로 가지 않고 바로 로그인된 것으로 친다.
  function go(to) {
    history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var u = new URL(a.getAttribute('href'), location.href);
    if (u.origin !== location.origin || u.pathname.indexOf('/auth/') !== 0) return;
    e.preventDefault();
    loggedIn = true;
    var next = u.searchParams.get('next');
    var safe = next && next.charAt(0) === '/' && next.charAt(1) !== '/' ? next : null;
    // 승인 대기 사용자도 돌아갈 주소(예: 연결 링크)를 잃지 않는다.
    if (me().status === 'pending') go('/pending' + (safe ? '?next=' + encodeURIComponent(safe) : ''));
    else go(safe || '/');
  }, true);

  // 텔레그램 연결 링크(https://t.me/<데모 봇>?start=…)는 실제로 열지 않는다. 봇 이름이 지어낸 값이라서다.
  // 앱은 누른 순간 빈 탭을 열고 나중에 주소를 넣으므로, 빈 탭 열기도 가짜 탭으로 바꾼다. BotFather 안내 링크는 그대로 둔다.
  function isDemoBotLink(href) {
    try {
      var u = new URL(href, location.href);
      return u.hostname === 't.me' && u.pathname.toLowerCase() !== '/botfather';
    } catch (e) { return false; }
  }
  var realOpen = window.open ? window.open.bind(window) : null;
  window.open = function (url) {
    if (!url || url === 'about:blank' || isDemoBotLink(url)) {
      return { closed: false, opener: null, location: { href: '' }, close: function () { this.closed = true; }, focus: function () {} };
    }
    return realOpen ? realOpen.apply(window, arguments) : null;
  };
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !isDemoBotLink(a.getAttribute('href'))) return;
    e.preventDefault();
  }, true);

  // ── 주소 바꾸기와 앱 불러오기 ──────────────────────────
  // 데모에서는 서비스 워커·푸시를 쓰지 않는다(설정 › 알림에 "지원하지 않습니다" 안내가 보인다).
  try { Object.defineProperty(window, 'PushManager', { value: undefined, configurable: true, writable: true }); } catch (e) { /* 무시 */ }
  history.replaceState(null, '', startView);

  var assets = window.__CMON_DEMO_ASSETS__ || { css: [], js: [] };
  (assets.css || []).forEach(function (href) {
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL(href, BASE).href;
    document.head.appendChild(l);
  });
  function loadApp() {
    (assets.js || []).forEach(function (src) {
      var s = document.createElement('script');
      s.type = 'module';
      s.src = new URL(src, BASE).href;
      document.head.appendChild(s);
    });
  }

  // 대시보드에서 sel로 고른 세션을 연다(카드를 눌러 준다).
  function openSelected() {
    if (!selWanted || startPath !== '/') return;
    var target = sessions.filter(function (s) { return s.id === selWanted || s.name === selWanted; })[0];
    if (!target) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      var cards = document.querySelectorAll('button.card');
      for (var i = 0; i < cards.length; i++) {
        var label = cards[i].getAttribute('aria-label') || '';
        if (label.indexOf(target.name + ' · ') === 0) { clearInterval(timer); cards[i].click(); return; }
      }
      if (tries > 100) clearInterval(timer);
    }, 100);
  }

  // 새 창에서 직접 열었을 때만 작은 데모 표시를 단다(목차의 틀 안에서는 목차가 이미 알려 준다).
  function addBadge() {
    var framed;
    try { framed = window.top !== window.self; } catch (e) { framed = true; }
    if (framed) return;
    var b = document.createElement('a');
    b.href = new URL('index.html', BASE).href;
    b.textContent = '데모 · 예시 데이터 · 목차로';
    b.setAttribute('aria-label', '예시 데이터로 동작하는 데모입니다. 목차로 돌아가기');
    b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;padding:6px 10px;border-radius:999px;' +
      'background:rgba(20,20,20,.82);color:#fff;font:500 12px/1.4 system-ui,sans-serif;text-decoration:none;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.2)';
    document.body.appendChild(b);
  }

  function ready() { loadApp(); openSelected(); addBadge(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
