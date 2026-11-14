# C-Monitor 2차(원격 답장) 구현 계획

**Goal:** 웹 대시보드에서 세션의 승인(허용 / 이 세션 동안 허용 / 거부), 선택지 질문, 글 보내기에 바로 답하고, 원격 제어가 켜진 세션은 공식 화면으로 여는 링크를 보여 준다.

**Spec:** `docs/superpowers/specs/2026-11-14-c-monitor-design.md` 7절. 계약은 `shared/src/contract.ts`의 "원격 답장(2차)" 절이 기준이다.

## 실험으로 확인한 사실 (클로드코드 2.1.32x, 2026-11-14)

| 무엇 | 결과 |
|---|---|
| `PermissionRequest` 훅(동기)이 기다리는 동안 | 터미널의 승인 창이 **함께 뜬다**. 훅이 `allow`를 돌려주면 창이 닫히고 실행된다("Allowed by PermissionRequest hook") |
| 터미널에서 먼저 답하면 | 바로 진행된다. 훅 프로세스는 죽지 않고 남아 있다가 스스로 끝난다(출력은 버려진다) |
| 훅 입력 | `session_id, cwd, permission_mode, tool_name, tool_input, permission_suggestions[]`. `tool_use_id`는 없다 |
| `permission_suggestions` 예 | `[{type:'addDirectories',directories:[…],destination:'session'},{type:'setMode',mode:'acceptEdits',destination:'session'}]` — 터미널의 "Yes, and …" 선택지와 같은 것 |
| `AskUserQuestion` | 같은 `PermissionRequest` 훅이 불리고 질문 창도 함께 뜬다. `decision:{behavior:'allow',updatedInput:{...tool_input, answers:{[질문 글]: 고른 label}}}`를 돌려주면 그 답으로 진행된다 |
| 멈춘 세션 깨우기 | `Stop` 훅을 `async:true, asyncRewake:true`로 두고, 프로세스가 stderr에 글을 쓰고 **종료 코드 2**로 끝나면 멈춰 있던 세션이 그 글을 받아 다시 일한다("Stop hook feedback") |
| 원격 제어 주소 | `/remote-control`을 켠 세션은 훅 환경변수 `CLAUDE_CODE_BRIDGE_SESSION_ID=session_…`가 생긴다(문서에 없는 값). 주소는 `https://claude.ai/code/<그 값>`. 대화 기록에도 `type:'system', subtype:'bridge_status', url` 줄이 남는다 |
| 자동·우회 권한 모드 | 승인 창이 없으므로 `PermissionRequest`도 없다 |

## Global Constraints

- 1차 계획의 제약을 그대로 따른다(한글 합니다체, 플러그인 의존성 0, 디자인 토큰, 사용자별 격리, 비밀 커밋 금지).
- **저장소에는 실제 이메일·내부 호스트명·IP·운영 주소를 넣지 않는다.** 예시 주소는 `https://c-monitor.example.com`.
- 원격 답장은 **세션 소유자 본인만** 할 수 있다. 관리자도 남의 세션에는 답할 수 없다.
- 터미널이 항상 우선이다. 서버·플러그인 어디가 실패해도 터미널의 승인 창은 평소처럼 동작해야 한다 — `ask.mjs`는 문제가 있으면 **아무것도 출력하지 않고 0으로** 끝난다.
- 웹에서 답은 확인 창 없이 바로 보낸다.
- 컴퓨터별 스위치 `machines.remote_reply`(기본 켜짐)가 꺼져 있으면 그 컴퓨터의 세션에는 답할 수 없다.

## 동작 규칙

1. **승인·질문 등록** `POST /api/reply/ask`(기기 토큰): `reply_requests`에 저장하고, 그 세션을 `wait`·`seen=false`로 만들어 `session`을 내보낸다(알림 훅보다 6초쯤 빠르다). 세션 행이 아직 없으면 요청만 저장한다. 스위치가 꺼져 있으면 `{disabled:true}`.
2. **대기** `POST /api/reply/wait`: 답이 있으면 바로, 없으면 최대 `REPLY_POLL_SECONDS` 붙잡았다가 `pending`. 부를 때마다 `polled_at`을 갱신한다.
3. **끝난 요청 치우기**: ① 웹에서 답함 → `answered` ② 그 세션(같은 `agentId`)에서 요청보다 뒤의 `PostToolUse`·`PostToolUseFailure`·`UserPromptSubmit`·`Stop`·`StopFailure`·`SessionEnd` 이벤트가 옴 → 터미널에서 먼저 답한 것 → `gone` ③ `polled_at`이 `REPLY_STALE_SECONDS` 넘게 오래됨 → `gone` ④ 세션 삭제·기기 해제 → 삭제. `PreToolUse`로는 치우지 않는다(등록과 순서가 뒤바뀌어 올 수 있다). 치울 때마다 `session`을 다시 내보낸다.
4. **글 보내기**: `session_messages`에 쌓는다. 세션이 `done`이고 그 세션의 inbox 대기자가 붙어 있으면 바로 넘기고(`delivered_at`), 아니면 쌓아 두었다가 세션이 `done`이 되고 대기자가 붙는 순간 넘긴다. 같은 세션에 새 대기자가 붙으면 옛 대기자는 `gone`. 승인을 기다리는 중의 글은 웹이 `deny`+`message`로, 질문 중의 글은 `answer`로 보낸다.
5. **깨우는 글의 모양**(플러그인이 stderr에 씀): `[c-monitor] 사용자가 웹 대시보드에서 보낸 메시지입니다. 사용자의 다음 요청으로 받아들여 처리하세요.\n\n<글>`
6. **원격 제어 링크**: 훅 이벤트의 `remoteUrl`을 세션에 저장한다. 필드가 없으면(옛 플러그인) 그대로 두고, `null`이면 지운다.
7. **보관**: 끝난 `reply_requests`와 전달된 `session_messages`는 7일 뒤 정리한다.

## 작업 나눔 (동시에 진행, 서로의 폴더는 건드리지 않는다)

| 담당 | 범위 |
|---|---|
| 서버 | `server/` — 스키마(`reply_requests`, `session_messages`, `sessions.remote_url`), `server/src/reply/`(ask·wait·inbox·웹 답), 수집에서 규칙 3·6, 조회에 `pending`·`canReply`·`queuedMessages`·`remoteUrl`, `PATCH /api/machines/:id`, 정리 작업, 테스트 |
| 플러그인 | `plugin/` — `bin/ask.mjs`, `bin/inbox.mjs`, `hooks/hooks.json`, `hook.mjs`의 `remoteUrl`, 버전 0.2.0, 테스트, `plugin/README.md` |
| 웹 | `web/`, `docs/mockup/demo/demo.js` — 카드·상세·간단히 보기의 답장 UI, 설정의 컴퓨터별 스위치, 원격 제어 버튼, API 클라이언트, 테스트, 데모 |
| 통합(마지막) | `server/test/e2e.test.ts`에 실제 플러그인 스크립트로 승인·질문·글 흐름, 실제 세션으로 확인, 배포, 설명서·스크린샷 |

## Review Focus

1. 서버가 꺼져 있거나 느릴 때 — `ask.mjs`는 등록에 3초 넘게 쓰지 않고 조용히 끝나며 터미널 창에 영향이 없다.
2. 남의 세션 — 다른 사용자의 로그인·기기 토큰으로는 요청을 보거나 답하거나 글을 넣을 수 없다(404).
3. 터미널이 먼저 답한 뒤 웹에서 누름 — `409 no_pending`, 세션에는 아무 영향이 없다.
4. 같은 요청에 웹 답이 두 번 — 첫 번째만 적용된다.
5. 깨우는 글에 비밀·제어 문자·아주 긴 글 — 길이 제한(4000자), 그대로 전달하되 서버 기록에는 남기지 않는다(전달 뒤 본문 삭제).
