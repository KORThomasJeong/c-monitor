import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    include: ['test/**/*.test.ts'],
    // 테스트는 개발 DB에 임시 스키마를 만들어 쓴다(test/helpers 참고).
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
