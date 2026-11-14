---
description: 이 컴퓨터를 c-monitor 서버에 연결합니다 (인자 없이 실행하면 연결 상태 확인)
argument-hint: <서버주소> | --status | --disconnect
allowed-tools: Bash
---

이 컴퓨터를 c-monitor 대시보드 서버에 연결하는 명령입니다. 사용자가 준 인자: `$ARGUMENTS`

아래 순서를 그대로 따르세요.

1. 인자가 비어 있으면 Bash 도구로 다음을 실행하고, 출력을 사용자에게 그대로 보여 준 뒤 끝냅니다.

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/connect.mjs" --status
   ```

2. 인자가 있으면 Bash 도구로 다음을 **제한시간 10분(timeout 600000)** 으로 실행합니다. 사용자가 브라우저에서 승인할 때까지 기다리는 명령이므로 중간에 끊지 마세요.

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/connect.mjs" $ARGUMENTS
   ```

3. 명령이 출력한 내용을 고치거나 줄이지 말고 사용자에게 그대로 보여 줍니다. 특히 **링크**와 **확인 코드**는 한 글자도 바꾸지 마세요.

4. 명령이 실패로 끝났으면(서버에 닿지 않음, 거부·만료 등) 출력된 안내를 그대로 전하고, 다시 시도하려면 같은 명령을 한 번 더 실행하면 된다고 알려 줍니다. 스스로 설정 파일을 고쳐서 해결하려 하지 마세요.

참고: `--disconnect`는 연결을 끊고 상태줄을 원래대로 돌립니다. 토큰이 들어 있는 `~/.c-monitor/config.json`의 내용은 읽거나 출력하지 마세요.
