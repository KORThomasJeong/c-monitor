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
