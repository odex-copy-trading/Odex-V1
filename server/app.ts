// HTTP + WebSocket server wiring: allowlist -> CORS -> route -> rate limit -> auth -> handler.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { ControlPlane } from './control';
import type { Db } from './db';
import type { Env } from './env';
import { compile, HttpError, match, readJson, send, type Ctx, type LimitClass } from './http';
import { routes } from './routes';
import { makeAllowlist, RateLimiter, verifyJwt } from './security';
import { attachTelemetry } from './ws';
import type { BridgeEngine } from './engine/bridge';

const LIMITS: Record<Exclude<LimitClass, 'none'>, RateLimiter> = {
  auth: new RateLimiter(5, 5 / 60), // 5 attempts, refills one every 12 s
  read: new RateLimiter(300, 5), // burst 300, ~300/min
  write: new RateLimiter(60, 1), // burst 60, ~60/min
};

export function clientIp(req: IncomingMessage, trustProxy: boolean) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function createApp(env: Env, db: Db, cp: ControlPlane, bridge: BridgeEngine | null): { server: Server; close: () => void } {
  const table = compile(routes(env, db, cp));
  const allowed = makeAllowlist(env.ipAllowlist);
  const telemetry = attachTelemetry(env, db, cp, allowed);

  const server = createServer(async (req, res) => {
    const ip = clientIp(req, env.trustProxy);
    const url = new URL(req.url ?? '/', 'http://local');
    const origin = req.headers.origin;
    const cors: Record<string, string> = origin && env.corsOrigins.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'Retry-After' } : {};
    try {
      if (!allowed(ip)) throw new HttpError(403, 'Your IP is not on the allowlist');
      if (req.method === 'OPTIONS') {
        if (!cors['Access-Control-Allow-Origin']) throw new HttpError(403, 'Origin not allowed');
        return send(res, 204, undefined, { ...cors, 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Max-Age': '600' });
      }
      if (origin && !cors['Access-Control-Allow-Origin'] && req.method !== 'GET') throw new HttpError(403, 'Origin not allowed');

      const m = match(table, req.method ?? 'GET', url.pathname);
      if (!m) throw new HttpError(404, 'Not found');
      if (m === 'method') throw new HttpError(405, 'Method not allowed');
      const { route, params } = m;

      if (route.limit !== 'none') {
        const wait = LIMITS[route.limit].take(`${route.limit}:${ip}`);
        if (wait) throw new HttpError(429, 'Too many requests', { retryAfterSec: wait });
      }
      let claims = null;
      if (route.auth) {
        const h = String(req.headers.authorization ?? '');
        const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
        claims = bearer ? verifyJwt(env.jwtSecret, bearer, (j) => db.isRevoked(j)) : null;
        if (!claims && bearer && env.devApiKey) {
          const a = Buffer.from(bearer), b = Buffer.from(env.devApiKey);
          if (a.length === b.length && timingSafeEqual(a, b)) {
            const now = Math.floor(Date.now() / 1000);
            claims = { sub: 'dev-api-key', role: 'operator' as const, jti: 'dev', iat: now, exp: now + 3600 };
          }
        }
        if (!claims) throw new HttpError(401, 'Sign in required', {});
      }
      const ctx: Ctx = { req, res, ip, params, query: url.searchParams, body: await readJson(req), claims, actor: claims?.sub ?? 'anonymous' };
      const out = await route.handler(ctx);
      send(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, out ?? { ok: true }, cors);
    } catch (e) {
      if (e instanceof HttpError) {
        const extra: Record<string, string> = e.status === 429 ? { 'Retry-After': String(e.extra.retryAfterSec ?? 1) } : e.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {};
        return send(res, e.status, { error: e.message, ...e.extra }, { ...cors, ...extra });
      }
      const status = (e as { status?: number }).status;
      if (typeof status === 'number' && status >= 400 && status < 600) return send(res, status, { error: (e as Error).message }, cors);
      console.error('[http] unhandled', e);
      send(res, 500, { error: 'Internal error' }, cors);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const ip = clientIp(req, env.trustProxy);
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    if (path === '/ws/telemetry') return telemetry.handleUpgrade(req, socket, head, ip);
    if (path === '/internal/engine' && bridge && allowed(ip)) return bridge.handleUpgrade(req, socket, head);
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  return { server, close: () => { telemetry.close(); server.close(); } };
}
