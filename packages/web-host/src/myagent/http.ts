import type { IncomingMessage, ServerResponse } from 'node:http';
import { requestJson, type JsonResponse } from './io.js';
import type { JsonObject } from './gateway.js';

export type CoreCall = (path: string, method?: string, body?: unknown, headers?: Record<string, string>) => Promise<JsonResponse>;
export function coreClient(port: number): CoreCall {
  return (path, method = 'GET', body, headers) => requestJson(`http://127.0.0.1:${port}${path}`, { method, body, headers, timeoutMs: 60000 });
}
export function sessionHeaders(req: IncomingMessage): Record<string, string> {
  const cookie = req.headers.cookie;
  const csrfHeader = typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined;
  const csrfCookie = cookie?.match(/(?:^|;\s*)aionui-csrf-token=([^;]+)/)?.[1];
  const csrf = csrfHeader || (csrfCookie ? decodeURIComponent(csrfCookie) : undefined);
  return {
    ...(cookie ? { cookie } : {}),
    ...(typeof req.headers.authorization === 'string' ? { authorization: req.headers.authorization } : {}),
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
  };
}
export function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
export async function readJsonBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<JsonObject | undefined> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > limit) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(buffer);
  }
  if (!bytes) return undefined;
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_JSON_BODY');
  return value as JsonObject;
}
export function sendJson(res: ServerResponse, status: number, payload: unknown, cookies?: string[]): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(cookies ? { 'set-cookie': cookies } : {}) });
  res.end(JSON.stringify(payload));
}
export function relayJson(res: ServerResponse, response: JsonResponse): void {
  sendJson(res, response.status, response.payload, response.headers['set-cookie']);
}
export function dataOf(response: JsonResponse): unknown { return response.payload.data ?? response.payload; }
export function succeeded(response: JsonResponse): boolean { return response.status >= 200 && response.status < 300 && response.payload.success !== false; }
