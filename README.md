# C-Monitor

여러 컴퓨터에서 도는 클로드코드 세션의 상태·대화·5시간/주간 한도를 한 화면에서 실시간으로 보는 대시보드와, 그 정보를 보내는 클로드코드 플러그인입니다.

- 카드 색으로 상태를 봅니다: 빨강(답변·승인 기다림), 초록(작업 끝남), 파랑(작업 중), 주황 점선(연락 끊김), 회색(종료).
- "간단히" 버튼을 누르면 타일만 보이는 모드가 되고, 휴대폰을 가로로 놓으면 한 화면에 맞습니다.
- 로그인은 구글 계정으로 하고, 관리자가 승인한 사람만 씁니다. 자기 컴퓨터와 세션만 보입니다.

## 플러그인 설치와 연결

클로드코드 안에서:

```
/plugin marketplace add KORThomasJeong/c-monitor
/plugin install c-monitor@c-monitor
/c-monitor:connect https://c-monitor.example.com
```

화면에 나온 링크를 열어 구글로 로그인하고, 터미널의 확인 코드와 같은지 본 뒤 "연결 승인"을 누르면 끝입니다. 그 뒤로는 이 컴퓨터의 모든 세션이 자동으로 전송됩니다. 자세한 내용은 [plugin/README.md](plugin/README.md).

보내기 전에 API 키·토큰·비밀번호처럼 보이는 글자는 플러그인이 가립니다. 서버가 꺼져 있어도 클로드코드는 느려지지 않고, 못 보낸 내용은 다음에 이어서 보냅니다.

## 폴더

| 폴더 | 내용 |
|---|---|
| `shared/` | 서버·웹·플러그인이 함께 따르는 API 계약과 상태 규칙 |
| `server/` | 수집·조회 API, 로그인, 기기 연결, 실시간 스트림 (Hono + Postgres) |
| `web/` | 대시보드 화면 (React) |
| `plugin/` | 클로드코드 플러그인 (의존성 없는 Node 스크립트) |
| `deploy/` | 도커 이미지와 컴포즈 구성 |
| `docs/` | 설계 문서, 구현 계획, 디자인 목업 |

## 개발

```
npm install
npm test                 # 전체 테스트
npm run dev -w server    # 서버 (저장소 루트의 .env.dev 사용)
npm run dev -w web       # 웹 (http://localhost:5173, API는 3000으로 넘김)
```

서버 테스트는 `.env.dev`의 `DATABASE_URL`이 가리키는 Postgres에 임시 스키마를 만들어 쓰고 끝나면 지웁니다.

## 배포

`deploy/env.prod.example`을 서버의 `deploy/.env.prod`로 복사해 값을 채운 뒤:

```
docker compose -f deploy/compose.yml --env-file deploy/.env.prod up -d --build
```

앱 컨테이너(`c-monitor-app:3000`)는 호스트 포트를 열지 않고 프록시 네트워크로만 들어옵니다. 실시간 스트림을 위해 프록시에서 버퍼링을 꺼야 합니다(`proxy_buffering off;`).
