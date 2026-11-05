import { describe, expect, it } from 'vitest';
import { gatewayInput, progressCursor, terminalText } from '../../../packages/web-host/src/myagent/gateway';

describe('real Gateway wire contract projections', () => {
  it('preserves a stable message identity and routes by conversation_id', () => {
    expect(gatewayInput('aionui:conversation', 'read the requested file', 'same-message')).toMatchObject({
      goal: 'read the requested file', conversation_id: 'aionui:conversation',
      metadata: { message_id: 'same-message' },
    });
  });
  it('does not put an asserted owner, password or channel in the request body', () => {
    const body = gatewayInput('aionui:conversation', 'hello', 'id');
    expect(body).not.toHaveProperty('user_id'); expect(body).not.toHaveProperty('channel');
  });
  it('advances the native next cursor on empty filtered progress pages', () => {
    expect(progressCursor({ events: [], next: 17 }, 4)).toBe(17);
  });
  it.each([-1, 3, '18', undefined, 1.5])('rejects invalid or backwards cursors (%s)', (next) => {
    expect(() => progressCursor({ events: [], next }, 4)).toThrow('INVALID_GATEWAY_PROGRESS');
  });
  it('does not confuse a queued or processing result with completion', () => {
    expect(terminalText({ status: 'processing', response: 'not terminal' })).toBeUndefined();
  });
  it('returns the real terminal response without synthesizing output', () => {
    expect(terminalText({ status: 'done', ok: true, response: 'real terminal response' })).toBe('real terminal response');
  });
  it('fails an unsuccessful terminal result instead of displaying fake success', () => {
    expect(() => terminalText({ status: 'failed', ok: false, error: 'request failed' })).toThrow('GATEWAY_REQUEST_FAILED');
  });
});
