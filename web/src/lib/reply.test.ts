import { describe, expect, it } from 'vitest';
import { mkMachine, mkSession } from '../test/fixtures';
import { answerOf, answersOf, isInstantQuestion, replyBlockReason, safeRemoteUrl, versionAtLeast } from './reply';

describe('원격 답장 도우미', () => {
  it('플러그인 버전을 숫자로 비교한다', () => {
    expect(versionAtLeast('0.2.0', '0.2.0')).toBe(true);
    expect(versionAtLeast('0.10.0', '0.2.0')).toBe(true);
    expect(versionAtLeast('1.0', '0.2.0')).toBe(true);
    expect(versionAtLeast('0.2.1-beta', '0.2.0')).toBe(true);
    expect(versionAtLeast('0.1.9', '0.2.0')).toBe(false);
    expect(versionAtLeast('', '0.2.0')).toBe(false);
    expect(versionAtLeast('알 수 없음', '0.2.0')).toBe(false);
  });

  it('답할 수 없는 까닭을 고른다(종료·끊김은 아무것도 보이지 않음)', () => {
    const m = mkMachine({ id: 'm1', pluginVersion: '0.2.0', remoteReply: true });
    expect(replyBlockReason(mkSession({ id: 'a', canReply: true }), m)).toBeNull();
    expect(replyBlockReason(mkSession({ id: 'a', status: 'end' }), m)).toBeNull();
    expect(replyBlockReason(mkSession({ id: 'a', status: 'lost' }), m)).toBeNull();
    expect(replyBlockReason(mkSession({ id: 'a' }), { ...m, remoteReply: false })).toMatch(/원격 답장이 꺼져/);
    expect(replyBlockReason(mkSession({ id: 'a' }), { ...m, pluginVersion: '0.1.3' })).toMatch(/0\.2\.0 이상으로 업데이트/);
    expect(replyBlockReason(mkSession({ id: 'a', sharedBy: 'x@example.com' }), m)).toMatch(/공유받은/);
    expect(replyBlockReason(mkSession({ id: 'a' }), m)).toMatch(/지금 웹에서 답할 수 없습니다/);
  });

  it('원격 제어 주소는 공식 화면만 받는다', () => {
    expect(safeRemoteUrl('https://claude.ai/code/session_01Ab-c')).toBe('https://claude.ai/code/session_01Ab-c');
    expect(safeRemoteUrl('https://claude.ai.example.com/code/x')).toBeNull();
    expect(safeRemoteUrl('javascript:alert(1)')).toBeNull();
    expect(safeRemoteUrl(null)).toBeNull();
  });

  it('질문 답 만들기: 단일 선택은 직접 쓴 글 우선, 다중 선택은 이어 붙임', () => {
    const one = { question: 'Q', options: [{ label: 'A' }] };
    const many = { question: 'M', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] };
    expect(answerOf(one, { picked: ['A'], text: '' })).toBe('A');
    expect(answerOf(one, { picked: ['A'], text: ' 직접 ' })).toBe('직접');
    expect(answerOf(many, { picked: ['A', 'B'], text: 'C' })).toBe('A, B, C');
    expect(answersOf([one, many], { 0: { picked: ['A'], text: '' } })).toBeNull();
    expect(answersOf([one, many], { 0: { picked: ['A'], text: '' }, 1: { picked: ['B'], text: '' } })).toEqual({ Q: 'A', M: 'B' });
    expect(isInstantQuestion([one])).toBe(true);
    expect(isInstantQuestion([many])).toBe(false);
    expect(isInstantQuestion([one, one])).toBe(false);
  });
});
