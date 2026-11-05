import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
export type JsonResponse = { status: number; payload: Record<string, unknown>; headers: IncomingHttpHeaders };

/** Read a bounded private deployment credential; never include it in an error. */
export async function readPrivateText(file: string): Promise<string> {
  try {
    if (!isAbsolute(file)) throw new Error('invalid');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 131072 || (info.mode & 0o037) !== 0) throw new Error('invalid');
      const text = (await handle.readFile('utf8')).trim();
      if (!text) throw new Error('invalid');
      return text;
    } finally { await handle.close(); }
  } catch { throw new Error('PRIVATE_CREDENTIAL_UNAVAILABLE'); }
}

/** Native HTTP JSON request without redirect following or browser headers. */
export async function requestJson(url: string, options: {
  method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number;
} = {}): Promise<JsonResponse> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('INVALID_UPSTREAM_URL');
  const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request(parsed, {
      agent: false, method: options.method || 'GET',
      headers: { accept: 'application/json', ...options.headers,
        ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}) },
    }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume(); reject(new Error('UPSTREAM_REDIRECT_REJECTED')); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { response.destroy(); reject(new Error('UPSTREAM_RESPONSE_TOO_LARGE')); }
        else chunks.push(chunk);
      });
      response.once('error', () => reject(new Error('UPSTREAM_UNAVAILABLE')));
      response.once('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
          resolve({ status: response.statusCode || 502, payload, headers: response.headers });
        } catch { reject(new Error('INVALID_UPSTREAM_JSON')); }
      });
    });
    const timer = setTimeout(() => { request.destroy(); reject(new Error('UPSTREAM_TIMEOUT')); }, options.timeoutMs || 15000);
    const abort = (): void => { request.destroy(); reject(new Error('REQUEST_CANCELLED')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    request.once('close', () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); });
    request.once('error', () => reject(new Error('UPSTREAM_UNAVAILABLE')));
    if (options.signal?.aborted) abort();
    if (body) request.write(body);
    request.end();
  });
}
