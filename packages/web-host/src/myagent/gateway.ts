import { randomUUID } from 'node:crypto';
import type { MyAgentConfig } from './config.js';
import { readPrivateText, requestJson } from './io.js';
import { setTimeout as delay } from 'node:timers/promises';

export type JsonObject = Record<string, unknown>;
export type GatewayIdentity = { userId: string; channel: string } | undefined;

/** Real HTTP Gateway transport. There is intentionally no mock or CLI retry fallback. */
export class GatewayClient {
  constructor(readonly config: MyAgentConfig, readonly identity: GatewayIdentity = undefined) {}
  private async call(path: string, body?: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    const headers: Record<string, string> = {};
    // GatewayClientCredentials.headers() uses X-Gateway-Token, not Bearer auth.
    // Send exactly one transport credential header and never retry anonymously.
    if (this.config.gatewayTokenFile) headers['x-gateway-token'] = await readPrivateText(this.config.gatewayTokenFile);
    if (this.identity) {
      headers['x-user-id'] = this.identity.userId;
      headers['x-channel'] = this.identity.channel;
    }
    const result = await requestJson(this.config.gatewayUrl + path, { method: body ? 'POST' : 'GET', body, headers, signal });
    if (result.status < 200 || result.status >= 300 || result.payload.ok === false) throw new Error(`GATEWAY_HTTP_${result.status}`);
    return result.payload;
  }
  /** Read native Gateway status without a business request envelope. */
  async status(signal?: AbortSignal): Promise<JsonObject> {
    return this.call('/status', undefined, signal);
  }
  /** Submit one business operation with a fresh transport request identity. */
  async business(action: string, params: JsonObject = {}, idempotencyKey?: string, signal?: AbortSignal): Promise<JsonObject> {
    return this.call('/client/business', {
      action, request_id: randomUUID(), params,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    }, signal);
  }
  /** List the skills visible to the configured Gateway identity. */
  async listSkills(params: JsonObject = {}, signal?: AbortSignal): Promise<JsonObject> {
    return this.business('skills.list', params, undefined, signal);
  }
  /** Set a skill's enabled state through the business API. */
  async setSkillEnabled(skillId: string, enabled: boolean, signal?: AbortSignal): Promise<JsonObject> {
    return this.business('skills.set_enabled', { skill_id: skillId, enabled }, undefined, signal);
  }
  /** List pending approvals visible to the configured Gateway identity. */
  async listApprovals(params: JsonObject = {}, signal?: AbortSignal): Promise<JsonObject> {
    return this.business('approvals.list', params, undefined, signal);
  }
  /** Repeated identical decisions use the same business idempotency key. */
  async decideApproval(approvalId: string, decision: 'approve' | 'deny', signal?: AbortSignal): Promise<JsonObject> {
    return this.business('approvals.decide', { approval_id: approvalId, decision }, `decide-${approvalId}-${decision}`, signal);
  }
  async models(conversationId: string): Promise<JsonObject> {
    return this.call('/client/models', { operation: 'list', conversation_id: conversationId });
  }
  async history(conversationId: string): Promise<JsonObject> {
    return this.call('/client/history', { conversation_id: conversationId, limit: 100 });
  }
  /** List the caller's first or subsequent Gateway session page. */
  async listSessions(conversationId: string, cursor?: string, signal?: AbortSignal): Promise<JsonObject> {
    return this.call('/client/history', {
      operation: 'list', conversation_id: conversationId, include_inflight: true,
      ...(cursor ? { cursor } : {}),
    }, signal);
  }
  /** Read a listed thread without changing the caller's Gateway identity. */
  async sessionHistory(conversationId: string, threadId: string, limit: number, before?: number, signal?: AbortSignal): Promise<JsonObject> {
    return this.call('/client/history', {
      conversation_id: conversationId, target_thread_id: threadId, limit,
      ...(before !== undefined ? { before_message_cursor: before } : {}),
    }, signal);
  }
  /** Relay a validated progress cursor without ever retrying anonymously. */
  async progress(requestId: string, since: number, signal?: AbortSignal): Promise<JsonObject> {
    if (!/^[A-Za-z0-9_.:-]{1,240}$/.test(requestId) || !Number.isSafeInteger(since) || since < 0) {
      throw new Error('INVALID_GATEWAY_PROGRESS');
    }
    return this.call(`/progress/${encodeURIComponent(requestId)}?since=${since}`, undefined, signal);
  }
  async selectModel(conversationId: string, profileId: string): Promise<void> {
    await this.call('/client/models', { operation: 'select', profile_id: profileId, conversation_id: conversationId });
  }
  async ask(conversationId: string, goal: string, messageId: string): Promise<JsonObject> {
    return this.call('/ask', gatewayInput(conversationId, goal, messageId));
  }
  async waitForResult(requestId: string, onEvent?: (event: JsonObject) => Promise<void>, signal?: AbortSignal): Promise<string> {
    if (!/^[A-Za-z0-9_.:-]{1,240}$/.test(requestId)) throw new Error('INVALID_GATEWAY_REQUEST_ID');
    const end = Date.now() + 30 * 60 * 1000;
    let cursor = 0;
    while (Date.now() < end) {
      const progress = await this.call(`/progress/${encodeURIComponent(requestId)}?since=${cursor}`, undefined, signal);
      cursor = progressCursor(progress, cursor);
      for (const event of progress.events as JsonObject[]) await onEvent?.(event);
      const result = await this.call(`/result/${encodeURIComponent(requestId)}`, undefined, signal);
      const text = terminalText(result);
      if (text !== undefined) return text;
      await delay(500, undefined, { signal });
    }
    throw new Error('GATEWAY_RESULT_TIMEOUT');
  }
  async cancel(conversationId: string, messageId: string = randomUUID()): Promise<void> {
    await this.call('/control', { command: '/stop', conversation_id: conversationId, metadata: { message_id: messageId } });
  }
}

/** Build the actual legacy Gateway /ask body; actor identity stays in headers. */
export function gatewayInput(conversationId: string, goal: string, messageId: string): JsonObject {
  if (!conversationId || !goal || !messageId) throw new Error('INVALID_GATEWAY_INPUT');
  return { conversation_id: conversationId, goal, verbose_level: 'stream', metadata: { message_id: messageId } };
}

/** Consume the server's cursor even when its public event projection is empty. */
export function progressCursor(page: JsonObject, previous: number): number {
  const next = page.next;
  if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < previous || !Array.isArray(page.events)) {
    throw new Error('INVALID_GATEWAY_PROGRESS');
  }
  return next;
}

/** Only canonical terminal results may become an assistant response. */
export function terminalText(result: JsonObject): string | undefined {
  if (result.status === 'failed' || result.ok === false || result.error) throw new Error('GATEWAY_REQUEST_FAILED');
  if (result.status !== 'done' && result.status !== 'completed') return undefined;
  if (typeof result.response !== 'string') throw new Error('INVALID_GATEWAY_TERMINAL');
  return result.response;
}
