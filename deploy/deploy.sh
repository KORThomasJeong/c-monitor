#!/usr/bin/env bash
# 서버에서 실행하는 배포 스크립트. 저장소 폴더 안에서:
#   bash deploy/deploy.sh
# DB를 백업하고, 최신 코드를 받아 다시 빌드·기동한 뒤 정상인지 확인한다.
# 새 버전이 뜨지 못하면 0이 아닌 코드로 끝난다.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=deploy/.env.prod
[[ -f "$ENV_FILE" ]] || { echo "deploy/.env.prod 가 없습니다. deploy/env.prod.example 을 복사해 채워 주세요." >&2; exit 1; }
compose() { docker compose -f deploy/compose.yml --env-file "$ENV_FILE" "$@"; }

# 1. DB 백업(이미 떠 있을 때만). 백업 파일만 소유자 전용으로 만든다.
#    umask 를 스크립트 전체에 걸면 git 이 받은 소스까지 읽기 불가가 되므로 하위 셸에서만 쓴다.
if docker ps --format '{{.Names}}' | grep -qx c-monitor-db; then
  backup="$HOME/c-monitor-db-backup-$(date +%Y%m%d-%H%M%S).sql.gz"
  ( umask 077; docker exec c-monitor-db pg_dump -U cmonitor -d cmonitor | gzip > "$backup" )
  echo "DB 백업: $backup ($(stat -c %s "$backup") 바이트)"
fi

# 2. 최신 코드
git pull --ff-only
echo "배포할 커밋: $(git log --oneline -1)"

# 3. 빌드·기동
compose up -d --build

# 4. 정상 확인(최대 60초)
for _ in $(seq 1 20); do
  status=$(docker inspect -f '{{.State.Health.Status}}' c-monitor-app 2>/dev/null || echo none)
  [[ "$status" == healthy ]] && { echo "앱 정상: $(docker ps --filter name=c-monitor-app --format '{{.Status}}')"; exit 0; }
  sleep 3
done
echo "앱이 정상 상태가 되지 않았습니다. 최근 로그:" >&2
docker logs c-monitor-app 2>&1 | tail -20 >&2
exit 1
