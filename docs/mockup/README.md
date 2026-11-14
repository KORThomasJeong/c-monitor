# 화면 데모

C-Monitor 웹 화면을 **예시 데이터로** 눌러 볼 수 있는 정적 데모입니다. 실제 서버와 연결되지 않습니다.
`main`에 올라가면 GitHub Actions(`.github/workflows/pages.yml`)가 GitHub Pages에 배포합니다.

## 폴더 구성

| 경로 | 내용 |
| --- | --- |
| `index.html` | 목차. 화면을 기기 틀(PC·태블릿·휴대폰 세로·가로) 안에 띄우고 라이트·다크를 바꿔 봅니다. 의존성 없는 HTML 한 장입니다. |
| `demo/demo.js` | 가짜 서버. 앱보다 먼저 실행돼 `fetch`와 `EventSource`를 가로채고, 지어낸 데이터로 API에 답하며 몇 초마다 상태 변화를 흘려 보냅니다. |
| `build-demo.mjs` | `web/`을 `--base=./`로 빌드해 `_site/`에 목차·`app.html`·자산·캔버스 원본을 조립합니다. 로컬과 Actions가 같이 씁니다. |
| `canvas/` | 디자인 캔버스 원본(`*.dc.html`). 캔버스 도구 전용이라 일반 브라우저에서는 열리지 않습니다. |
| `_site/` | 빌드 결과. 커밋하지 않습니다(`.gitignore`). |

데모는 `web/src`를 고치지 않고 빌드 결과만 씁니다. 화면이 바뀌면 다시 빌드하기만 하면 됩니다.

## 로컬에서 열기

```bash
npm ci                         # 처음 한 번
node docs/mockup/build-demo.mjs
npx vite preview --outDir docs/mockup/_site --port 4310
```

브라우저에서 `http://localhost:4310/`을 엽니다. 정적 서버라면 무엇이든 되고, 하위 경로(`/c-monitor/`)에서 서빙해도 됩니다.
`file://`로 바로 열면 모듈 스크립트가 막혀 동작하지 않습니다.

## 화면 주소

`app.html` 뒤에 쿼리로 시작 화면을 고릅니다. 목차의 "새 창에서 열기"가 이 주소를 씁니다.

| 쿼리 | 값 | 뜻 |
| --- | --- | --- |
| `view` | `/` · `/login` · `/pending` · `/connect?code=…` · `/settings` · `/admin` · `/withdrawn` · `/s/<토큰>` | 시작 화면. 뒤에 `?`·`#`를 붙여 앱 주소를 그대로 줄 수 있습니다(아래 예) |
| `theme` | `light` · `dark` | 테마 |
| `mode` | `detail` · `deck` | 대시보드 상세 / 간단히 보기 |
| `user` | `admin`(기본) · `user` · `pending` · `consent` · `leaving` | 로그인한 사람. `user`는 일반 사용자, `pending`은 승인 대기, `consent`는 가입 고지 동의 전, `leaving`은 탈퇴를 신청한 사람 |
| `sel` | 세션 이름(예: `search-api`) | 대시보드에서 그 세션 상세를 엽니다 |

`view` 값에 `?`·`#`가 들어가면 주소에 넣을 때 `%3F`·`%23`처럼 바꿔 씁니다(목차는 알아서 바꿉니다).

| 보고 싶은 것 | 주소 |
|---|---|
| 승인 대기 세션에 답하기 | `app.html?view=/&sel=search-api` |
| 선택지 질문에 답하기 | `app.html?view=/&sel=blog-site` |
| 끝난 세션에 글 보내기, 텔레그램 답 기록 줄 | `app.html?view=/&sel=drawing-review` |
| 긴 대화와 검색 | `app.html?view=/&sel=api-gateway` |
| 다크 테마 | `app.html?view=/&mode=detail&sel=search-api&theme=dark` |
| 설정 › 알림(텔레그램 연결·웹 알림·소리) | `app.html?view=%2Fsettings%23notify` |
| 설정 › 계정(저장 용량·탈퇴), 일반 사용자 | `app.html?view=%2Fsettings%23account&user=user` |
| 관리 › 알림(봇 토큰) | `app.html?view=%2Fadmin%23notify` |
| 관리 › 컴퓨터 / 저장 용량 | `app.html?view=%2Fadmin%23machines` · `app.html?view=%2Fadmin%23storage` |
| 공개 링크로 본 세션 | `app.html?view=/s/demo` |
| 관리자가 남의 대시보드를 읽기 전용으로 | `app.html?view=%2F%3Fuser%3Du-member` |
| 기록에 있는 세션 바로 열기(알림 링크처럼) | `app.html?view=%2F%3Fsession%3Ddemo-legacy-migration` |
| 가입 고지 동의 화면 | `app.html?view=/&user=consent` |
| 탈퇴 취소 화면 | `app.html?view=/&user=leaving` |

앱이 주소(`location.pathname`)로 화면을 고르기 때문에, 열린 뒤에는 주소창이 `/settings`처럼 사이트 맨 위 경로로 바뀝니다.
그 상태에서 새로고침하면 GitHub Pages에서는 없는 주소라 404가 나니, 목차에서 다시 여세요.

## 예시 데이터

- 이메일·컴퓨터·프로젝트 이름·텔레그램 봇 이름은 모두 지어낸 값입니다(`dev@company-a.example`, `admin@example.com`, `server-a`, `search-api`, `@c_monitor_demo_bot` 등).
- 세션 상태가 고루 들어 있습니다: 답변 기다림(실행 승인·질문), 작업 끝남, 작업 중 여러 개, 연락 끊김, 종료, 한도 초과.
- 컴퓨터 4대, 클로드 계정 2개(한 계정은 5시간 한도 80% 넘음), 비밀이 가려진 줄, 긴 대화(`api-gateway`)가 있습니다.
- 저장·승인·연결 해제는 그 창 안의 메모리에만 반영되고, 새로 열면 처음으로 돌아갑니다.
- 원격 답장: `search-api`는 실행 승인, `blog-site`는 선택지 질문을 기다립니다. 답하면 작업 중으로 바뀌고 대화에 답과 "웹에서 … 답했습니다" 기록 줄이 붙습니다. 끝난 세션에 글을 보내면 잠시 뒤 답이 오고, 작업 중이면 끝난 뒤에 전달됩니다. 설정에서 컴퓨터의 원격 답장을 끄면 그 컴퓨터 세션에는 답할 수 없습니다.
- 텔레그램: 처음엔 연결 안 됨이고, "텔레그램 연결"을 누르면 실제 텔레그램을 열지 않고 몇 초 뒤 연결된 것으로 칩니다. `api-gateway`는 세션 알림을 꺼 두었습니다.
- 웹 알림: 데모 브라우저는 지원하지 않는 것으로 치고(안내만 나옴), 이 계정에 켜 둔 브라우저 하나가 목록에 있습니다.
- 공유: 상세 패널 "공유"로 링크를 만들거나 사람을 지정해 볼 수 있고, `designer@example.com`이 공유한 세션 두 개가 "공유받은 세션" 묶음에 있습니다.
- 기록 탭에는 오래전에 끝난 세션 두 개가 더 있습니다. 관리 화면에는 승인 대기·초대됨·정지됨·탈퇴 예정 사용자와 다른 사용자의 컴퓨터가 있습니다.
- 데모의 컴퓨터는 플러그인 버전이 `plugin/.claude-plugin/plugin.json`과 같은 0.3.1로 적혀 있습니다(`demo.js`의 `PLUGIN_VER`, 플러그인 버전을 올리면 같이 고칩니다).
  관리 › 컴퓨터의 `old-desktop`만 "업데이트 필요" 태그를 보여 주려고 일부러 0.1.0으로 두었습니다.
- 관리자가 남의 대시보드를 볼 때(`app.html?view=%2F%3Fuser%3Du-member`)는 그 사용자의 세션·컴퓨터와 함께 그 사용자의 클로드 계정 한도 카드도 보입니다.
