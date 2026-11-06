import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayClient } from './gateway.js';
import { readJsonBody, sameOrigin, sendJson } from './http.js';

/** Host-owned gates must return true explicitly; a denial may send its own response. */
export type MyAgentRouteGuard = (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;

/** The host supplies its existing session and CSRF validators; neither is optional. */
export type MyAgentRouteService = {
  gateway: Pick<GatewayClient, 'status' | 'listSkills' | 'listApprovals' | 'decideApproval'>;
  requireAuth: MyAgentRouteGuard;
  requireCsrf: MyAgentRouteGuard;
};

/**
 * Handle the my-agent business endpoints using the host's mandatory security gates.
 * Returns false only for unrelated paths so it can precede the normal proxy handler.
 * Auth must authorize access to the configured Gateway identity, not an asserted user.
 */
export async function handleMyAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  service: MyAgentRouteService,
): Promise<boolean> {
  const path = new URL(req.url || '/', 'http://localhost').pathname;
  const decide = /^\/api\/myagent\/approvals\/([^/]+)\/decide$/.exec(path);
  if (!decide && !['/api/myagent/status', '/api/myagent/skills', '/api/myagent/approvals'].includes(path)) return false;

  try {
    if (await service.requireAuth(req, res) !== true) {
      if (!res.headersSent) sendJson(res, 401, { success: false, error: 'AUTH_REQUIRED' });
      return true;
    }
    if (res.headersSent) return true;
    const allowedMethod = decide ? 'POST' : 'GET';
    if (req.method !== allowedMethod) {
      res.setHeader('allow', allowedMethod);
      sendJson(res, 405, { success: false, error: 'METHOD_NOT_ALLOWED' });
      return true;
    }

    if (decide) {
      // Never synthesize the CSRF header from the cookie for these mutations.
      if (!sameOrigin(req) || await service.requireCsrf(req, res) !== true) {
        if (!res.headersSent) sendJson(res, 403, { success: false, error: 'CSRF_REQUIRED' });
        return true;
      }
      if (res.headersSent) return true;
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { success: false, error: 'JSON_REQUIRED' });
        return true;
      }
      const id = decodeURIComponent(decide[1]);
      if (!id.trim() || id.length > 240 || /[\u0000-\u001f\u007f]/.test(id)) {
        sendJson(res, 400, { success: false, error: 'INVALID_APPROVAL_ID' });
        return true;
      }
      const body = await readJsonBody(req, 16384);
      const decision = body?.decision;
      if (decision !== 'approve' && decision !== 'deny') {
        sendJson(res, 400, { success: false, error: 'INVALID_APPROVAL_DECISION' });
        return true;
      }
      sendJson(res, 200, await service.gateway.decideApproval(id, decision));
    } else {
      const payload = path === '/api/myagent/status' ? await service.gateway.status()
        : path === '/api/myagent/skills' ? await service.gateway.listSkills() : await service.gateway.listApprovals();
      sendJson(res, 200, payload);
    }
  } catch (error) {
    if (res.headersSent) return true;
    const code = error instanceof URIError ? 'INVALID_PATH'
      : error instanceof SyntaxError || error instanceof Error && error.message === 'INVALID_JSON_BODY' ? 'INVALID_JSON_BODY'
      : error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'MY_AGENT_GATEWAY_UNAVAILABLE';
    sendJson(res, code === 'REQUEST_TOO_LARGE' ? 413 : code === 'INVALID_PATH' || code === 'INVALID_JSON_BODY' ? 400 : 502,
      { success: false, error: code });
  }
  return true;
}
