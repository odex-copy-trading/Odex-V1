// Minimal HTTP router with JSON bodies, typed errors and security headers.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Claims } from './security';

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  ip: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  claims: Claims | null;
  actor: string;
}

export type LimitClass = 'auth' | 'read' | 'write' | 'none';
export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string; // e.g. /api/kols/:id
  auth: boolean;
  limit: LimitClass;
  handler: (ctx: Ctx) => unknown | Promise<unknown>;
}

interface Compiled extends Route { re: RegExp; keys: string[] }
export function compile(routes: Route[]): Compiled[] {
  return routes.map((r) => {
    const keys: string[] = [];
    const re = new RegExp('^' + r.path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    return { ...r, re, keys };
  });
}

export function match(routes: Compiled[], method: string, pathname: string) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return pathMatched ? 'method' : null;
}

export async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined;
  const type = req.headers['content-type'] ?? '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(c as Buffer);
  }
  if (size === 0) return undefined;
  if (!type.includes('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, ...(data ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(data);
}
