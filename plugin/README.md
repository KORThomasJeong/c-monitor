# c-monitor — c-monitor 플러그인

클로드코드 세션의 상태·대화·5시간/주간 한도를 c-monitor 서버로 보내는 플러그인입니다.
여러 컴퓨터에서 도는 세션을 대시보드 한 화면에서 볼 수 있습니다.

## 설치

클로드코드 안에서 실행합니다.

```
/plugin marketplace add KORThomasJeong/c-monitor
/plugin install c-monitor@c-monitor
```

Node 18 이상이 필요합니다(`node` 명령이 PATH에 있어야 합니다). 다른 의존성은 없습니다.

## 연결

```
/c-monitor:connect https://c-monitor.example.com
```

1. 화면에 **링크**와 **확인 코드**(예: `K7QM-2XPA`)가 바로 나오고, 기본 브라우저가 그 링크로 자동으로 열립니다.
   원격 접속(SSH)처럼 화면이 없는 환경에서는 열지 않으니 링크를 직접 열어 주세요.
2. 구글로 로그인하고 코드를 확인한 뒤 승인합니다(10분 안에). 웹에서 거부하면 연결이 바로 취소됩니다.
3. 승인되면 이 컴퓨터가 등록되고, 그때부터 모든 세션이 자동으로 전송됩니다.

브라우저를 자동으로 열고 싶지 않으면 환경변수 `C_MONITOR_NO_OPEN=1`을 설정하세요.

터미널에서 직접 실행할 수도 있습니다(플러그인 폴더에서).

```
node bin/connect.mjs <서버주소>            # 요청하고 승인될 때까지 기다림
node bin/connect.mjs <서버주소> --start    # 요청하고 링크·코드만 출력한 뒤 바로 끝남
node bin/connect.mjs --wait                # --start로 시작한 요청의 승인을 기다려 연결을 마침
node bin/connect.mjs <서버주소> --no-open  # 브라우저를 자동으로 열지 않음
```

`/c-monitor:connect`는 `--start`와 `--wait`를 차례로 실행합니다. 클로드코드는 명령이 끝나야 출력을 보여 주기 때문에,
링크를 먼저 보여 주고 나서 승인을 기다리도록 두 단계로 나눠 두었습니다.

연결 상태 확인:

```
/c-monitor:connect
```

## 연결 해제

```
/c-monitor:connect --disconnect
```

서버에 알려 이 컴퓨터의 토큰을 폐기하고, 상태줄을 원래대로 돌린 뒤 연결 설정(토큰)을 지웁니다.
서버에 닿지 않으면 이 컴퓨터 쪽만 해제하고 알려 주니, 그때는 웹의 설정 화면에서 이 컴퓨터를 해제해 주세요. 플러그인까지 지우려면 `/plugin uninstall c-monitor@c-monitor`.
**플러그인을 지우기 전에 먼저 연결을 해제해 주세요.** 그래야 상태줄이 원래 명령으로 돌아갑니다.

## 무엇을 보내나요

| 종류 | 내용 |
|---|---|
| 훅 이벤트 | 세션 시작·종료, 질문 입력, 도구 실행 전후, 알림(승인 요청 등), 작업 끝남 |
| 대화 | 세션 대화 기록(transcript)을 훅마다 늘어난 만큼만 읽어 보냅니다. 사용자 글·어시스턴트 글·도구 입력과 결과 |
| 한도 | 상태줄 입력의 5시간·주간 사용률과 초기화 시각(60초에 한 번) |
| 그 밖 | 클로드 계정 이메일, 작업 폴더, 깃 브랜치, 모델, 컴퓨터 이름·OS·플러그인 버전 |

**비밀 가림** — 보내기 전에 이 컴퓨터에서 API 키·토큰·`password=` 류를 `••••••••`로 바꿉니다
(`sk-…`, `ghp_…`, `AKIA…`, `xoxb-…`, `AIza…`, `GOCSPX-…`, `ya29.…`, JWT, `Bearer …`, 개인 키 블록 등). 가린 개수도 함께 보냅니다.
모양으로 찾는 방식이라 완벽하지는 않습니다. 대화에 민감한 내용을 적을 때는 이 점을 생각해 주세요.

## 클로드코드에 주는 영향

- 훅은 모두 비동기(`async: true`)라 클로드코드를 기다리게 하지 않습니다. 훅은 아무것도 출력하지 않습니다.
- 서버가 꺼져 있으면 3초 안에 포기하고 디스크 큐(`~/.c-monitor/queue/`)에 남겼다가 다음 훅에서 순서대로 다시 보냅니다. 큐는 200묶음까지 두고 넘치면 오래된 것부터 버립니다.
- 웹의 설정 화면에서 이 컴퓨터를 해제하면, 플러그인은 다음 전송 때 이를 알아채고 큐를 비운 뒤 전송을 멈춥니다. `/c-monitor:connect`로 상태를 확인할 수 있고, 다시 연결하면 전송이 이어집니다.
- 연결하면 `~/.claude/settings.json`의 `statusLine`을 래퍼로 바꿉니다. 래퍼는 원래 상태줄 명령을 그대로 실행해 출력도 그대로 보여 줍니다(claude-hud 등 유지). 바꾸기 전 내용은 `settings.json.c-monitor.bak`으로 남깁니다.

## 파일 위치

| 위치 | 내용 |
|---|---|
| `~/.c-monitor/config.json` | 서버 주소, 기기 토큰, 컴퓨터 이름, 원래 상태줄 설정 |
| `~/.c-monitor/queue/` | 아직 못 보낸 묶음 |
| `~/.c-monitor/state/` | 세션별 대화 읽은 위치, 한도 마지막 전송 시각 |
| `~/.c-monitor/bin/statusline.mjs` | 상태줄 래퍼(복사본) |

환경변수 `C_MONITOR_HOME`으로 위치를 바꿀 수 있습니다. 클로드코드 설정 폴더는 `CLAUDE_CONFIG_DIR`를 따릅니다.

## 개발

저장소 루트에서:

```
npx vitest run --project plugin
```

테스트는 모두 임시 폴더에서 돌며 실제 `~/.claude`, `~/.c-monitor`를 건드리지 않습니다.

구조:

```
bin/hook.mjs        훅 진입점(이벤트 + 대화 증분 → 큐 → 전송)
bin/connect.mjs     연결(--start / --wait)·상태·해제 명령
bin/statusline.mjs  상태줄 래퍼(lib를 쓰지 않는 자급형 — 복사돼서 실행됨)
lib/config.mjs      저장 위치·설정 파일·진행 중인 연결 요청(pending.json)
lib/os.mjs          운영체제 표기(연결·훅·상태줄 래퍼가 같은 값을 보냄)
lib/browser.mjs     승인 링크를 기본 브라우저로 열기
lib/account.mjs     클로드 계정 이메일
lib/mask.mjs        비밀 가림
lib/transcript.mjs  대화 기록 증분 읽기
lib/queue.mjs       디스크 큐·묶음 나누기
lib/send.mjs        HTTP 전송
```
