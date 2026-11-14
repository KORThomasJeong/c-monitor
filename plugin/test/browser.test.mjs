// 브라우저 자동 열기. 실제 프로세스는 절대 띄우지 않는다 — 가짜 spawn만 넣는다.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { browserCommand, openBrowser } from '../lib/browser.mjs';

const URL_ = 'https://cs.test/connect?code=K7QM-2XPA&from=cli';

/** 가짜 spawn. outcome: 'spawn'(성공) | 'error'(실행 파일 없음) | 'throw' */
function fakeSpawn(outcome = 'spawn') {
  const calls = [];
  const spawn = (file, args, options) => {
    if (outcome === 'throw') throw new Error('spawn 실패');
    const child = new EventEmitter();
    child.unref = () => { child.unrefCalled = true; };
    calls.push({ file, args, options, child });
    setImmediate(() => child.emit(outcome, outcome === 'error' ? new Error('ENOENT') : undefined));
    return child;
  };
  return { spawn, calls };
}

describe('browserCommand', () => {
  it('운영체제별 명령을 고른다(셸을 거치지 않아 주소의 &가 그대로 간다)', () => {
    expect(browserCommand(URL_, { platform: 'win32', env: {} })).toEqual({ file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', URL_] });
    expect(browserCommand(URL_, { platform: 'darwin', env: {} })).toEqual({ file: 'open', args: [URL_] });
    expect(browserCommand(URL_, { platform: 'linux', env: { DISPLAY: ':0' } })).toEqual({ file: 'xdg-open', args: [URL_] });
    expect(browserCommand(URL_, { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } })).toEqual({ file: 'xdg-open', args: [URL_] });
  });

  it('화면이 없는 환경이면 열지 않는다', () => {
    expect(browserCommand(URL_, { platform: 'linux', env: {} })).toBeNull();
    expect(browserCommand(URL_, { platform: 'linux', env: { DISPLAY: ':0', SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' } })).toBeNull();
    expect(browserCommand(URL_, { platform: 'win32', env: { SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' } })).toBeNull();
    expect(browserCommand(URL_, { platform: 'darwin', env: { SSH_TTY: '/dev/ttys001' } })).toBeNull();
    expect(browserCommand(URL_, { platform: 'freebsd', env: { DISPLAY: ':0' } })).toBeNull();
  });

  it('C_MONITOR_NO_OPEN이 켜져 있으면 열지 않는다', () => {
    expect(browserCommand(URL_, { platform: 'win32', env: { C_MONITOR_NO_OPEN: '1' } })).toBeNull();
    expect(browserCommand(URL_, { platform: 'win32', env: { C_MONITOR_NO_OPEN: '0' } })).not.toBeNull();
    expect(browserCommand(URL_, { platform: 'win32', env: { C_MONITOR_NO_OPEN: '' } })).not.toBeNull();
  });

  it('http·https 주소가 아니면 열지 않는다(서버가 준 주소로 다른 프로그램을 띄우지 않게)', () => {
    for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'C:\\Windows\\notepad.exe', '', 'not a url', null]) {
      expect(browserCommand(bad, { platform: 'win32', env: {} })).toBeNull();
    }
    expect(browserCommand('http://127.0.0.1:8080/connect', { platform: 'win32', env: {} })).not.toBeNull();
  });
});

describe('openBrowser', () => {
  it('열었으면 true — 자식은 detached·stdio ignore로 띄우고 unref한다', async () => {
    const f = fakeSpawn('spawn');
    expect(await openBrowser(URL_, { platform: 'win32', env: {}, spawn: f.spawn })).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].file).toBe('rundll32.exe');
    expect(f.calls[0].args).toEqual(['url.dll,FileProtocolHandler', URL_]);
    expect(f.calls[0].options).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(f.calls[0].options.shell).toBeFalsy();
    expect(f.calls[0].child.unrefCalled).toBe(true);
  });

  it('C_MONITOR_NO_OPEN=1이거나 noOpen이면 열려는 시도조차 하지 않는다', async () => {
    const f = fakeSpawn('spawn');
    expect(await openBrowser(URL_, { platform: 'win32', env: { C_MONITOR_NO_OPEN: '1' }, spawn: f.spawn })).toBe(false);
    expect(await openBrowser(URL_, { platform: 'win32', env: {}, noOpen: true, spawn: f.spawn })).toBe(false);
    expect(await openBrowser(URL_, { platform: 'linux', env: {}, spawn: f.spawn })).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('여는 데 실패해도 예외 없이 false', async () => {
    expect(await openBrowser(URL_, { platform: 'linux', env: { DISPLAY: ':0' }, spawn: fakeSpawn('error').spawn })).toBe(false);
    expect(await openBrowser(URL_, { platform: 'darwin', env: {}, spawn: fakeSpawn('throw').spawn })).toBe(false);
  });
});
