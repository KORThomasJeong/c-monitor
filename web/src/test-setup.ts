import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vitest 전역(globals)을 안 쓰므로 testing-library 자동 정리가 걸리지 않는다. 직접 정리한다.
afterEach(() => cleanup());

// Node 22+의 내장 localStorage(파일 지정 없으면 undefined)가 jsdom 것을 가린다.
// vitest가 넣어 주는 jsdom 인스턴스의 저장소로 다시 연결한다.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (dom) {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, get: () => dom.window[key] });
  }
}
