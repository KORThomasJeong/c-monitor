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
| `view` | `/` · `/login` · `/pending` · `/connect?code=…` · `/settings` · `/admin` | 시작 화면 |
| `theme` | `light` · `dark` | 테마 |
| `mode` | `detail` · `deck` | 대시보드 상세 / 간단히 보기 |
| `user` | `admin`(기본) · `user` · `pending` | 로그인한 사람의 권한·상태 |
| `sel` | 세션 이름(예: `search-api`) | 대시보드에서 그 세션 상세를 엽니다 |

예: `app.html?view=/&mode=detail&sel=search-api&theme=dark`

앱이 주소(`location.pathname`)로 화면을 고르기 때문에, 열린 뒤에는 주소창이 `/settings`처럼 사이트 맨 위 경로로 바뀝니다.
그 상태에서 새로고침하면 GitHub Pages에서는 없는 주소라 404가 나니, 목차에서 다시 여세요.

## 예시 데이터

- 이메일·컴퓨터·프로젝트 이름은 모두 지어낸 값입니다(`dev@company-a.example`, `server-a`, `search-api` 등).
- 세션 상태가 고루 들어 있습니다: 답변 기다림(실행 승인·질문), 작업 끝남, 작업 중 여러 개, 연락 끊김, 종료, 한도 초과.
- 컴퓨터 4대, 클로드 계정 2개(한 계정은 5시간 한도 80% 넘음), 비밀이 가려진 줄, 긴 대화(`api-gateway`)가 있습니다.
- 저장·승인·연결 해제는 그 창 안의 메모리에만 반영되고, 새로 열면 처음으로 돌아갑니다.
- 웹에서 답장 보내기·알림·공유처럼 아직 없는 기능은 데모에도 없습니다.
