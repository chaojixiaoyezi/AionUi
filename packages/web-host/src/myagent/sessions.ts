import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayClient, GatewayIdentity, JsonObject } from './gateway.js';
import { sameOrigin, sendJson } from './http.js';
import { objectOf } from './bootstrap.js';

export type Caller = { userId: string; admin: boolean; identity: GatewayIdentity | null };

/** Resolve a trusted host identity or a validated, non-privileged Gateway user. */
export function gatewayIdentityFor(
  user: { id: string; username?: unknown },
  admin: boolean,
  env: NodeJS.ProcessEnv
): GatewayIdentity | null {
  if (admin) return undefined;
  const username = user.username;
  const channel = env.MY_AGENT_GATEWAY_USER_CHANNEL || 'local';
  if (
    typeof username !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(username) ||
    /^(admin|main|local-agent|anonymous)$/i.test(username) ||
    !/^[A-Za-z0-9._-]{1,32}$/.test(channel) ||
    /^(chat|cli|terminal|gateway-cli|http)$/i.test(channel)
  )
    return null;
  return { userId: username, channel };
}

/** Encode the public binding identifiers, never a store or filesystem path. */
export function externalConversationId(conversationId: string, threadId: string): string {
  return 'myagent-gw-' + Buffer.from(JSON.stringify([conversationId, threadId])).toString('base64url');
}

/** Reject malformed, non-canonical or oversized external identifiers. */
export function parseExternalConversationId(id: string): { conversationId: string; threadId: string } | null {
  if (!id.startsWith('myagent-gw-') || id.length > 1024) return null;
  const encoded = id.slice('myagent-gw-'.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return null;
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value.some((part) => typeof part !== 'string' || !part || part.length > 512)
    )
      return null;
    return { conversationId: value[0] as string, threadId: value[1] as string };
  } catch {
    return null;
  }
}

/** Reserve external conversation subroutes before the normal Core proxy. */
export function isExternalConversationPath(path: string): boolean {
  return /^\/api\/conversations\/myagent-gw-[A-Za-z0-9_-]+(?:\/.*)?$/.test(path);
}

/** Identify every Gateway-backed route that must reject an unusable identity. */
export function isGatewayBridgePath(path: string): boolean {
  return (
    ['/api/myagent/status', '/api/myagent/skills', '/api/myagent/approvals'].includes(path) ||
    /^\/api\/myagent\/approvals\/[^/]+\/decide$/.test(path) ||
    path.startsWith('/api/myagent/sessions/progress/')
  );
}

/** Project only the public session metadata into the existing renderer row shape. */
function conversationRow(item: JsonObject, ownerId: unknown): JsonObject {
  const conversationId = String(item.conversation_id);
  const threadId = String(item.thread_id);
  return {
    id: externalConversationId(conversationId, threadId),
    type: 'acp',
    name: item.title || conversationId,
    created_at: Math.round(Number(item.created_at || 0) * 1000),
    modified_at: Math.round(Number(item.updated_at || 0) * 1000),
    status: item.status === 'running' || item.status === 'queued' ? 'running' : 'finished',
    source: 'my-agent',
    extra: {
      gateway: {
        conversation_id: conversationId,
        thread_id: threadId,
        channel: item.channel,
        channel_user_id: item.channel_user_id,
        owner_id: ownerId,
        status: item.status,
        in_flight: item.in_flight,
        active_request_id: item.active_request_id,
        active_run_id: item.active_run_id,
        message_count: item.message_count,
        preview: item.preview,
        read_only: true,
      },
    },
  };
}

/** Read through the caller's Gateway catalog without persisting or repaginating Core. */
export async function mergeGatewaySessions(
  gateway: Pick<GatewayClient, 'listSessions'>,
  userId: string,
  payload: JsonObject
): Promise<JsonObject> {
  try {
    const catalog = await gateway.listSessions(`aionui:${userId}:catalog`);
    if (!Array.isArray(catalog.items) || catalog.ok === false) throw new Error('INVALID_GATEWAY_SESSIONS');
    const rows = catalog.items
      .map(objectOf)
      .filter(
        (item) =>
          typeof item.conversation_id === 'string' &&
          !!item.conversation_id &&
          typeof item.thread_id === 'string' &&
          !!item.thread_id &&
          !/^(aionui:|apagent-conv-|apagent-task-)/.test(item.conversation_id)
      )
      .map((item) => conversationRow(item, catalog.owner_id));
    if (Array.isArray(payload.data)) return { ...payload, data: [...rows, ...payload.data] };
    const data = objectOf(payload.data);
    if (Array.isArray(data.items) && typeof data.total === 'number') {
      return { ...payload, data: { ...data, items: [...rows, ...data.items], total: data.total + rows.length } };
    }
    return payload;
  } catch {
    return { ...payload, gateway_error: 'MY_AGENT_GATEWAY_UNAVAILABLE' };
  }
}

/** Parse bounded decimal query values without accepting fractional or unsafe cursors. */
function queryInteger(value: string | null, fallback: number, minimum: number, maximum: number): number | undefined {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= minimum && result <= maximum ? result : undefined;
}

/** Project paired Gateway history turns and an optional live-work marker. */
function messagePage(history: JsonObject, id: string): JsonObject {
  const items: JsonObject[] = [];
  for (const turn of Array.isArray(history.turns) ? history.turns.map(objectOf) : []) {
    for (const [suffix, position, text] of [
      ['u', 'right', turn.user_message],
      ['a', 'left', turn.assistant_message],
    ]) {
      items.push({
        id: `${id}:${turn.request_id}:${suffix}`,
        conversation_id: id,
        type: 'text',
        position,
        content: { content: text },
        status: 'finish',
      });
    }
  }
  if (typeof history.in_flight_status === 'string' && history.in_flight_status !== 'idle') {
    items.push({
      id: `${id}:${history.active_request_id}:work`,
      conversation_id: id,
      type: 'tips',
      position: 'left',
      status: 'work',
      content: {
        content: 'Gateway 会话运行中',
        active_request_id: history.active_request_id,
        progress_path: history.progress_path,
      },
    });
  }
  return {
    items,
    oldest_cursor: history.before_message_cursor == null ? null : String(history.before_message_cursor),
    newest_cursor: history.message_cursor == null ? null : String(history.message_cursor),
    has_more_before: history.has_older === true,
    has_more_after: false,
  };
}

/** Authenticate and serve read-only external sessions without invoking the Core proxy. */
export async function handleExternalConversation(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  deps: {
    resolveCaller: (req: IncomingMessage) => Promise<Caller | undefined>;
    gatewayFor: (identity: GatewayIdentity) => GatewayClient;
  }
): Promise<true> {
  if (!['GET', 'HEAD'].includes(method) && !sameOrigin(req)) {
    sendJson(res, 403, { success: false, error: 'CROSS_SITE_REQUEST' });
    return true;
  }
  try {
    const caller = await deps.resolveCaller(req);
    if (!caller) {
      sendJson(res, 401, { success: false, error: 'AUTH_REQUIRED' });
      return true;
    }
    const match = /^\/api\/conversations\/([^/]+)(\/.*)?$/.exec(path);
    const parsed = match && parseExternalConversationId(match[1]);
    if (caller.identity === null || !parsed) {
      sendJson(res, 404, { success: false, error: 'NOT_FOUND' });
      return true;
    }
    if (!['GET', 'HEAD'].includes(method)) {
      sendJson(res, 409, { success: false, error: 'EXTERNAL_SESSION_READ_ONLY' });
      return true;
    }
    const suffix = match[2] || '';
    if (suffix === '/messages/latest') {
      sendJson(res, 200, { success: true, data: null });
      return true;
    }
    if (suffix && suffix !== '/messages') {
      sendJson(res, 404, { success: false, error: 'NOT_FOUND' });
      return true;
    }
    const query = new URL(req.url || '/', 'http://localhost').searchParams;
    const limit = suffix ? queryInteger(query.get('limit'), 50, 1, 100) : 1;
    const before = query.has('before') ? queryInteger(query.get('before'), 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
    if (limit === undefined || (query.has('before') && before === undefined)) {
      sendJson(res, 400, { success: false, error: 'INVALID_SESSION_QUERY' });
      return true;
    }
    const history = await deps
      .gatewayFor(caller.identity)
      .sessionHistory(parsed.conversationId, parsed.threadId, limit, before);
    if (history.ok === false || typeof history.thread_id !== 'string' || !history.thread_id) {
      sendJson(res, 404, { success: false, error: 'NOT_FOUND' });
      return true;
    }
    const data = suffix
      ? messagePage(history, match[1])
      : conversationRow(
          {
            ...history,
            conversation_id: parsed.conversationId,
            thread_id: parsed.threadId,
            status: history.in_flight_status && history.in_flight_status !== 'idle' ? 'running' : 'finished',
          },
          history.owner_id
        );
    sendJson(res, 200, { success: true, data });
  } catch (error) {
    // The transport rejects ok:false on a successful HTTP response before returning history.
    const missing = error instanceof Error && /^GATEWAY_HTTP_2\d\d$/.test(error.message);
    sendJson(res, missing ? 404 : 502, {
      success: false,
      error: missing ? 'NOT_FOUND' : 'MY_AGENT_GATEWAY_UNAVAILABLE',
    });
  }
  return true;
}

/** Validate and relay one authenticated progress page with no browser-selected identity. */
export async function handleSessionProgress(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  gateway: Pick<GatewayClient, 'progress'>
): Promise<true> {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    sendJson(res, 405, { success: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const requestId = path.slice('/api/myagent/sessions/progress/'.length);
  const since = queryInteger(
    new URL(req.url || '/', 'http://localhost').searchParams.get('since'),
    0,
    0,
    Number.MAX_SAFE_INTEGER
  );
  if (!/^[A-Za-z0-9_.:-]{1,240}$/.test(requestId) || since === undefined) {
    sendJson(res, 400, { success: false, error: 'INVALID_GATEWAY_PROGRESS' });
    return true;
  }
  try {
    const progress = await gateway.progress(requestId, since);
    sendJson(res, 200, { success: true, data: { events: progress.events, next: progress.next } });
  } catch {
    sendJson(res, 502, { success: false, error: 'MY_AGENT_GATEWAY_UNAVAILABLE' });
  }
  return true;
}
