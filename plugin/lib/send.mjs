// 서버로 JSON을 보낸다. 어떤 경우에도 예외를 던지지 않는다.
//
// 전역 fetch 대신 node:http/https 를 직접 쓴다. Windows의 Node 26에서 fetch를 쓴 뒤 process.exit()을 부르면
// libuv 단언 실패(UV_HANDLE_CLOSING)로 프로세스가 비정상 종료하기 때문이다 — 훅은 반드시 0으로 끝나야 한다.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** → {ok, status, json}. 연결 실패·제한시간 초과는 {ok:false, status:0, json:null}. */
export function postJson(url, body, token, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = () => {
      finish({ ok: false, status: 0, json: null });
      try { req?.destroy(); } catch { /* 무시 */ }
    };
    try {
      const target = new URL(url);
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const headers = { 'content-type': 'application/json', 'content-length': payload.length };
      if (token) headers.authorization = `Bearer ${token}`;
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      // 전체(연결·전송·응답)에 거는 제한시간
      timer = setTimeout(fail, timeoutMs);
      // agent:false — 연결을 재사용하지 않아 끝난 뒤 프로세스를 붙잡지 않는다.
      req = send(target, { method: 'POST', headers, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', fail);
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch { /* 본문이 JSON이 아님 */ }
          const status = res.statusCode ?? 0;
          finish({ ok: status >= 200 && status < 300, status, json });
        });
      });
      req.on('error', fail);
      req.end(payload);
    } catch {
      fail();
    }
  });
}
