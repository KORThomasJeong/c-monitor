-- C-Monitor 테이블 정의. 여러 번 실행해도 안전하다(멱등).
-- 스키마 이름을 붙이지 않으므로 연결의 search_path 첫 스키마에 만들어진다.

CREATE TABLE IF NOT EXISTS users (
  id          text PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  name        text,
  role        text NOT NULL DEFAULT 'user'    CHECK (role IN ('admin', 'user')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 로그인 세션. id는 쿠키 값의 sha256(원문은 저장하지 않는다).
CREATE TABLE IF NOT EXISTS web_sessions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS web_sessions_user_idx ON web_sessions (user_id);

-- 연결된 컴퓨터. token_hash는 기기 토큰의 sha256.
CREATE TABLE IF NOT EXISTS machines (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  os              text NOT NULL DEFAULT '',
  plugin_version  text NOT NULL DEFAULT '',
  token_hash      text NOT NULL UNIQUE,
  last_seen_at    timestamptz,
  revoked_at      timestamptz,
  remote_reply    boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS machines_user_idx ON machines (user_id);

-- 기기 연결 요청. device_code는 sha256으로 저장한다.
CREATE TABLE IF NOT EXISTS device_requests (
  device_code       text PRIMARY KEY,
  user_code         text NOT NULL UNIQUE,
  machine_name      text NOT NULL,
  os                text NOT NULL DEFAULT '',
  plugin_version    text NOT NULL DEFAULT '',
  expires_at        timestamptz NOT NULL,
  approved_user_id  text REFERENCES users(id) ON DELETE CASCADE,
  machine_id        text
);
-- 웹에서 연결 요청을 거부한 시각(나중에 추가된 열 — 이미 있는 테이블에도 안전하게 붙는다).
ALTER TABLE device_requests ADD COLUMN IF NOT EXISTS denied_at timestamptz;

-- 클로드 계정(대시보드 로그인 계정과 별개).
CREATE TABLE IF NOT EXISTS accounts (
  user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email    text NOT NULL,
  alias    text,
  hidden   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, email)
);

-- 세션. id = '<machineId>:<클로드 sessionId>'.
CREATE TABLE IF NOT EXISTS sessions (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_id      text NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  account         text,
  cwd             text NOT NULL DEFAULT '',
  branch          text,
  model           text,
  status          text NOT NULL CHECK (status IN ('run', 'wait', 'done', 'lost', 'end', 'limit')),
  seen            boolean NOT NULL DEFAULT true,
  started_at      timestamptz NOT NULL,
  last_event_at   timestamptz NOT NULL,
  ended_at        timestamptz,
  activity_label  text,
  activity_text   text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, last_event_at DESC);
CREATE INDEX IF NOT EXISTS sessions_run_idx ON sessions (last_event_at) WHERE status = 'run';

-- 이미 반영한 훅 이벤트 id(멱등 처리용). 기기별로 구분해 남의 id를 선점할 수 없게 한다.
CREATE TABLE IF NOT EXISTS event_ids (
  machine_id  text NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  id          text NOT NULL,
  at          timestamptz NOT NULL,
  PRIMARY KEY (machine_id, id)
);
CREATE INDEX IF NOT EXISTS event_ids_at_idx ON event_ids (at);

CREATE TABLE IF NOT EXISTS transcript_lines (
  session_id  text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  role        text NOT NULL,
  at          timestamptz NOT NULL,
  text        text NOT NULL,
  tool_name   text,
  tool_input  jsonb,
  truncated   boolean NOT NULL DEFAULT false,
  masked      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS transcript_lines_at_idx ON transcript_lines (at);

-- 사용자가 지운 세션의 표시. 지우기 전에 생긴 이벤트가 늦게 도착하거나 종료 알림만 와서
-- 지운 카드가 다시 생기는 일을 막는다. 그 세션이 실제로 다시 움직이면 표시를 지우고 새로 만든다.
CREATE TABLE IF NOT EXISTS deleted_sessions (
  session_id  text PRIMARY KEY,
  machine_id  text NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  deleted_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS deleted_sessions_at_idx ON deleted_sessions (deleted_at);

-- 한도 기록. resets는 epoch 초.
CREATE TABLE IF NOT EXISTS limits (
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account       text NOT NULL,
  five_pct      double precision NOT NULL,
  five_resets   bigint,
  seven_pct     double precision NOT NULL,
  seven_resets  bigint,
  at            timestamptz NOT NULL,
  PRIMARY KEY (user_id, account, at)
);
CREATE INDEX IF NOT EXISTS limits_at_idx ON limits (at);

CREATE TABLE IF NOT EXISTS settings (
  user_id          text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lost_minutes     integer NOT NULL DEFAULT 10,
  end_hours        integer NOT NULL DEFAULT 24,
  keep_chat_days   integer NOT NULL DEFAULT 30,
  keep_usage_days  integer NOT NULL DEFAULT 90
);

-- 공유(3차 계획에서 사용). 자리만 잡아 둔다.
CREATE TABLE IF NOT EXISTS shares (
  id              text PRIMARY KEY,
  session_id      text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id  text REFERENCES users(id) ON DELETE CASCADE,
  token           text UNIQUE,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shares_target_idx ON shares (target_user_id);

-- ── 원격 답장(2차) ──────────────────────────────────────────
-- 공식 원격 제어 화면 주소(세션에서 /remote-control 을 켰을 때만).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS remote_url text;

-- 웹에서 답할 수 있는 승인·질문. session_id에는 FK가 없다 — 세션 행보다 먼저 올 수 있다.
-- created_at은 기기 시계의 시각(훅 이벤트의 at과 견주기 위해), polled_at·answered_at은 서버 시각.
CREATE TABLE IF NOT EXISTS reply_requests (
  id             text PRIMARY KEY,
  session_id     text NOT NULL,
  machine_id     text NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('permission', 'question')),
  tool_name      text NOT NULL,
  tool_input     jsonb,
  questions      jsonb,
  session_allow  text,
  agent_id       text,
  created_at     timestamptz NOT NULL,
  polled_at      timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'gone')),
  answer         jsonb,
  answered_at    timestamptz
);
CREATE INDEX IF NOT EXISTS reply_requests_session_idx ON reply_requests (session_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS reply_requests_polled_idx ON reply_requests (polled_at);

-- 웹에서 세션으로 보낸 글. 전달하면 delivered_at을 찍고 본문(text)을 비운다.
CREATE TABLE IF NOT EXISTS session_messages (
  id            text PRIMARY KEY,
  session_id    text NOT NULL,
  machine_id    text NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text          text NOT NULL,
  created_at    timestamptz NOT NULL,
  delivered_at  timestamptz
);
CREATE INDEX IF NOT EXISTS session_messages_queue_idx ON session_messages (session_id, created_at) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS session_messages_created_idx ON session_messages (created_at);

-- ── 알림(텔레그램) ──────────────────────────────────────────
-- 사용자별 알림 항목 설정(기본값은 shared NOTIFY_DEFAULTS와 같다).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS notify_wait      boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS notify_done      boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS notify_lost      boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS notify_limit     boolean NOT NULL DEFAULT true;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS notify_limit_pct integer NOT NULL DEFAULT 80;

-- 세션별 텔레그램 스위치(기본 켬).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS telegram boolean NOT NULL DEFAULT true;

-- 공용 봇(행은 하나, id = 1). token_enc는 AES-256-GCM 암호문(notify/secret.ts) — 원문은 저장하지 않는다.
CREATE TABLE IF NOT EXISTS telegram_bot (
  id            integer PRIMARY KEY CHECK (id = 1),
  token_enc     text NOT NULL,
  token_hint    text NOT NULL,
  bot_username  text NOT NULL,
  updated_at    timestamptz NOT NULL
);

-- 사용자 ↔ 텔레그램 채팅(한 사용자 = 채팅 하나, 한 채팅 = 사용자 하나).
CREATE TABLE IF NOT EXISTS telegram_links (
  user_id    text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_id    bigint NOT NULL UNIQUE,
  name       text,
  linked_at  timestamptz NOT NULL
);

-- 연결 코드(10분 유효, 1회용). 사용자마다 하나 — 새로 받으면 옛 코드는 지워진다.
CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code        text PRIMARY KEY,
  user_id     text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);

-- 보낸 알림 메시지 ↔ 세션(답장·버튼 처리용, 7일 보관). html·keyboard는 버튼을 누른 뒤 메시지를 고쳐 쓰는 데 쓴다.
CREATE TABLE IF NOT EXISTS telegram_messages (
  id          bigserial PRIMARY KEY,
  chat_id     bigint NOT NULL,
  message_id  bigint,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  text REFERENCES sessions(id) ON DELETE CASCADE,
  request_id  text,
  html        text NOT NULL,
  keyboard    jsonb,
  created_at  timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_messages_msg_idx ON telegram_messages (chat_id, message_id);
CREATE INDEX IF NOT EXISTS telegram_messages_request_idx ON telegram_messages (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telegram_messages_created_idx ON telegram_messages (created_at);

-- 한도 알림을 보낸 기록. 같은 창(초기화 시각)에는 한 번만 보낸다. win: five | seven, resets_at: epoch 초(모르면 0).
CREATE TABLE IF NOT EXISTS limit_alerts (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account     text NOT NULL,
  win         text NOT NULL CHECK (win IN ('five', 'seven')),
  resets_at   bigint NOT NULL,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, account, win, resets_at)
);
CREATE INDEX IF NOT EXISTS limit_alerts_created_idx ON limit_alerts (created_at);

-- ══ 3차 ═══════════════════════════════════════════════════════
-- ── 계정: 동의·탈퇴·미리 추가·용량 ─────────────────────────────
-- consented_at: 가입 고지에 동의한 시각(null이면 웹이 동의 화면을 먼저 보여 준다)
-- delete_at:    탈퇴 신청 뒤 완전 삭제 예정 시각(null이면 탈퇴하지 않음). 값이 있으면 거의 모든 API가 403 withdrawn
-- invited:      관리자가 미리 추가했고 아직 한 번도 로그인하지 않음
-- quota_mb:     저장 용량 한도(MB, 0 = 무제한). trimmed_at: 한도 때문에 마지막으로 대화를 지운 시각
ALTER TABLE users ADD COLUMN IF NOT EXISTS consented_at  timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_at     timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited       boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_mb      integer NOT NULL DEFAULT 1024;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trimmed_at    timestamptz;
CREATE INDEX IF NOT EXISTS users_delete_idx ON users (delete_at) WHERE delete_at IS NOT NULL;

-- ── 컨텍스트 %·비용(상태줄이 보낸 마지막 값) ──────────────────
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS context_pct double precision;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cost_usd    double precision;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS stats_at    timestamptz;

-- ── 공유 ──────────────────────────────────────────────────────
-- 링크 공유: token에는 토큰 원문의 sha256만 둔다(원문은 만들 때 한 번만 내려준다). target_user_id는 null.
-- 사람 지정: target_user_id = 받은 사람, token은 null. 같은 세션·같은 사람은 하나만.
CREATE UNIQUE INDEX IF NOT EXISTS shares_session_target_idx ON shares (session_id, target_user_id) WHERE target_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shares_session_idx ON shares (session_id);

-- ── 웹 답 기록 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reply_records (
  id          text PRIMARY KEY,
  session_id  text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL,
  source      text NOT NULL CHECK (source IN ('web', 'telegram')),
  kind        text NOT NULL CHECK (kind IN ('permission', 'answer', 'message')),
  label       text NOT NULL
);
CREATE INDEX IF NOT EXISTS reply_records_session_idx ON reply_records (session_id, at);
CREATE INDEX IF NOT EXISTS reply_records_at_idx ON reply_records (at);

-- ── 글 전달 수신 확인(0.3.0 이상 플러그인) ─────────────────────
-- handed_at: 대기자에게 넘긴 시각. ack가 오면 delivered_at을 찍고 본문을 비운다. ack 없이 60초가 지나면 다시 넘긴다.
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS handed_at timestamptz;

-- ── 웹 푸시 ───────────────────────────────────────────────────
-- VAPID 키(행은 하나, id = 1). private_key_enc는 AES-256-GCM 암호문(notify/secret.ts).
CREATE TABLE IF NOT EXISTS push_keys (
  id               integer PRIMARY KEY CHECK (id = 1),
  public_key       text NOT NULL,
  private_key_enc  text NOT NULL,
  created_at       timestamptz NOT NULL
);
-- 브라우저 구독. 같은 endpoint는 하나(다른 사용자가 같은 브라우저로 구독하면 그 사용자 것으로 바뀐다).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  label       text,
  created_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);
-- 한 번만 보내야 하는 웹 푸시 기록(승인·질문 요청, 한도 창). key 예: 'req:<요청 id>', 'limit:<계정>:five:<초기화>'.
CREATE TABLE IF NOT EXISTS push_sent (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         text NOT NULL,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS push_sent_created_idx ON push_sent (created_at);
