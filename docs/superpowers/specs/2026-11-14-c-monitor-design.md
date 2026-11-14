# C-Monitor 설계 (확정본)

작성일 2026-11-14 · 사용자와 질문 라운드로 확정 · 디자인 목업: https://claude.ai/artifact/WYdfFAaJWokfGbaijXmTVE (사본 `docs/mockup/`)

## 1. 한 줄 요약

여러 컴퓨터에서 도는 클로드코드 세션의 상태·대화·5시간/주간 한도를 `https://c-monitor.example.com` 한 화면에서 실시간으로 보고, 필요하면 웹에서 답장하는 서비스. GitHub의 플러그인을 설치하고 `/c-monitor:connect <서버주소>`로 연결한다.

## 2. 구성

| 부분 | 역할 |
|---|---|
| 플러그인 (`plugin/`) | 훅 이벤트·대화 기록·상태줄 한도를 서버로 전송, 연결 명령 |
| 서버 (`server/`) | 수집 API, 로그인, 기기 연결, 조회 API, 실시간 스트림(SSE), 관리 |
| 웹 (`web/`) | 대시보드(상세·간단히), 상세 패널, 로그인·가입·연결 승인·관리 화면 |
| 배포 (`deploy/`) | server-a 도커 컴포즈, Nginx Proxy Manager, Cloudflare DNS |

## 3. 사용자와 권한

- 로그인: 구글(Gmail) 로그인만. 클로드 계정(dev@company-a.example, dev@company-b.example 등)과 대시보드 로그인 계정(admin@example.com 등)은 별개.
- 가입: 가입 페이지에서 구글 로그인으로 신청 → **관리자 승인** 후 사용. 신청이 오면 관리자에게 텔레그램 + 관리자 페이지 대기 목록.
- 관리자: `ADMIN_EMAILS`에 적은 주소는 자동 승인·관리자. **관리자는 모든 사용자의 대화를 볼 수 있음** — 가입 화면에서 고지·동의.
- 격리: 컴퓨터·세션·대화·사용량은 등록한 사용자 소유. 다른 사람은 API·실시간 스트림 어디서도 볼 수 없음(관리자 제외).
- 공유: 세션 단위. ① 링크 공유(로그인 없이 보기만, 만료 설정, 취소 가능) ② 사람 지정(가입 사용자의 대시보드에 "공유받은 세션"). 공유받은 사람은 **보기만**.
- 탈퇴·삭제: 즉시 접속·전송 차단, 7일 뒤 완전 삭제(그 전엔 복구 가능).
- 용량: 사용자당 기본 1GB, 관리자가 조절. 넘으면 오래된 대화부터 삭제하고 알림.

## 4. 수집

- 훅: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Notification, Stop, StopFailure, SubagentStop, SessionEnd. 모두 `type: command`, `async: true`, 서버가 죽어 있어도 클로드코드를 느리게 하지 않음(전송 제한시간 3초, 실패분은 디스크 큐에 보관 후 다음 훅에서 재전송).
- 대화: `transcript_path` JSONL을 훅마다 증분으로 읽어 전송(마지막 위치 저장). **대화 전체** 전송.
- 비밀 가림: 전송 전에 플러그인에서 API 키·토큰·`password=` 류를 `••••`로 바꿈. 가린 개수를 함께 보냄.
- 클로드 계정: 매 이벤트마다 `~/.claude.json`(또는 `$CLAUDE_CONFIG_DIR/.claude.json`)의 `oauthAccount.emailAddress`를 읽음 → cswap 전환도 자동 반영. 계정 수 제한 없음.
- 한도: 상태줄 입력의 `rate_limits.five_hour/seven_day.used_percentage`, `resets_at`(epoch 초). 연결 명령이 기존 상태줄 명령을 감싸는 래퍼로 바꾸고 기존 출력은 그대로 보여 줌(claude-hud 유지). 60초에 한 번만 전송.

## 5. 상태 규칙

| 상태 | 들어가는 조건 | 표시 |
|---|---|---|
| `wait` | Notification(permission_prompt / elicitation_dialog / agent_needs_input) 또는 PreToolUse(AskUserQuestion) | 빨강 깜박임, **카드를 열면 멈춤** |
| `done` | Stop(백그라운드 작업 없음) | 초록 깜박임, **다음 작업 시작까지 계속** |
| `run` | UserPromptSubmit, PreToolUse(그 외), PostToolUse, SubagentStop | 파랑 테두리 숨쉬기 |
| `lost` | `run`인데 10분(설정값) 넘게 이벤트 없음 | 주황 점선 |
| `end` | SessionEnd | 회색, 24시간(설정값) 뒤 기록 탭으로 |
| `limit` | StopFailure(rate_limit) | 주황 태그 "한도 초과" (`wait`과 같은 빨강 취급) |

`idle_prompt` 알림은 상태를 바꾸지 않는다(Stop이 이미 `done`으로 만듦).

## 6. 화면 (목업 기준)

- 대시보드 상세: 위쪽 계정별 한도 카드(4개까지 카드, 그 이상은 최근 사용 순 + "외 N개", 별칭·숨기기), 상태 필터, **컴퓨터별 묶음** 세션 카드, PC는 오른쪽 상세 패널 / 1024px 미만은 상세가 전체 화면.
- 간단히 보기(스트림덱): 헤더 "간단히" 버튼 → 타일만. 타일 탭 → 그 세션 상세. "상세" 버튼 → 원래 화면. 휴대폰 가로(높이 500px 이하)에서 4열 한 화면, 위쪽에 계정별 5시간·주간 %.
- 상세 패널: 대화/도구 탭, 계정·컴퓨터·폴더·브랜치·모델·시작·컨텍스트·비용.
- 테마: 라이트·다크, 기기 설정 따름 + 버튼(기기별 기억). 디자인은 design-lookbook 7 Quartz 토큰(`web/src/styles/app.css`, `deck.css`).
- 반응형: 휴대폰·태블릿·PC.

## 7. 원격 답장

- 카드에서 바로: 승인(허용/이 세션 동안 허용/거부), 선택지, 글 보내기. **확인 창 없이 바로** 보냄. 터미널에서 먼저 답하면 그쪽이 우선.
- "원격 제어로 열기": 공식 `--remote-control` 화면 링크.
- 관리자/내 설정에서 컴퓨터별 원격 답장 스위치(기본 켜짐).
- 미검증 항목(구현 전에 확인): AskUserQuestion을 훅으로 직접 답할 수 있는지(안 되면 "사용자가 X를 골랐습니다"를 지시로 전달), 원격 제어 세션별 딥링크 가능 여부.

## 8. 알림

- 웹 알림(Web Push) + 소리 켜고 끄기.
- 텔레그램: 공용 봇 하나, 사용자마다 `/start <코드>`로 연결. 항목별 켜고 끄기(답변 기다림 기본 켬, 끝남 끔, 끊김 켬, 한도 80% 켬).

## 9. 보관

- 대화 30일, 사용량 90일(사용자별 설정). 매일 04:00(KST) 정리.

## 10. 배포

- server-a(aarch64), 도커 컴포즈: `c-monitor-app` + `c-monitor-db`(Postgres 17). 앱은 `npm-network` 합류, 호스트 포트 없음.
- NPM 프록시 호스트 `c-monitor.example.com` → `c-monitor-app:3000`, 기존 와일드카드 인증서, Advanced에 `proxy_buffering off; proxy_read_timeout 1h;`.
- Cloudflare A 레코드(proxied) → <서버 IP>.
- 개발 DB: 원격 Postgres 17에 로컬 SSH 터널로 접속, 주소는 `.env.dev`의 `DATABASE_URL`(커밋하지 않음).
- 저장소: 공개 `KORThomasJeong/c-monitor`. 비밀 정보 커밋 금지.
