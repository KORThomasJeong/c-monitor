# c-monitor 서버 + 웹. 저장소 루트를 빌드 컨텍스트로 쓴다:
#   docker build -f deploy/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared shared
COPY web web
RUN npm run build -w web

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY tsconfig.base.json ./
COPY shared shared
COPY server/src server/src
COPY server/tsconfig.json server/
COPY --from=build /app/web/dist web/dist
# 받은 소스의 권한이 '소유자만 읽기'여도 실행 사용자(node)가 읽을 수 있게 맞춘다.
RUN chmod -R a+rX shared server web/dist tsconfig.base.json package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/src/index.ts"]
