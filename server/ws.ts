// /ws/telemetry: authenticated fan-out of engine telemetry to the UI.
// Browsers cannot set Authorization on a WebSocket, so the client sends {type:"auth", token} as its
// first message (the token never appears in a URL or proxy log). Unauthenticated sockets close after 5 s.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { TelemetryEvent, TelemetryType, WsClientMessage } from '../lib/telemetry';
import type { ControlPlane } from './control';
import type { Db } from './db';
import type { Env } from './env';
import { RateLimiter, verifyJwt } from './security';

const MAX_BUFFER = 1_000_000; // bytes; above this, drop high-rate events for that client
const DROPPABLE: TelemetryType[] = ['slot_tick', 'landers_updated', 'session_updated'];

interface Client { ws: WebSocket; authed: boolean; events: Set<TelemetryType> | '*'; ip: string; exp: number }

export function attachTelemetry(env: Env, db: Db, cp: ControlPlane, isAllowed: (ip: string) => boolean) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const clients = new Set<Client>();
  const msgLimit = new RateLimiter(20, 5);

  cp.on('telemetry', (e: TelemetryEvent) => {
    const data = JSON.stringify(e);
    const now = Date.now();
    for (const c of clients) {
      if (!c.authed || c.ws.readyState !== WebSocket.OPEN) continue;
      if (c.exp * 1000 < now) { c.ws.close(4401, 'Token expired'); continue; }
      if (c.events !== '*' && !c.events.has(e.type)) continue;
      if (c.ws.bufferedAmount > MAX_BUFFER && DROPPABLE.includes(e.type)) continue;
      c.ws.send(data);
    }
  });

  const ping = setInterval(() => { for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.ping(); }, 20_000);
  ping.unref();

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ip: string) {
    const origin = req.headers.origin;
    if (!isAllowed(ip) || (origin && !env.corsOrigins.includes(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Client = { ws, authed: false, events: '*', ip, exp: 0 };
      clients.add(c);
      const timer = setTimeout(() => { if (!c.authed) ws.close(4401, 'Authenticate within 5 seconds'); }, 5000);
      ws.on('close', () => { clearTimeout(timer); clients.delete(c); });
      ws.on('message', (raw) => {
        if (msgLimit.take(ip)) { ws.close(4429, 'Too many messages'); return; }
        let m: WsClientMessage;
        try { m = JSON.parse(String(raw)); } catch { ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' })); return; }
        if (m.type === 'auth') {
          const claims = verifyJwt(env.jwtSecret, String(m.token ?? ''), (j) => db.isRevoked(j));
          if (!claims) { ws.close(4401, 'Invalid token'); return; }
          c.authed = true; c.exp = claims.exp;
          clearTimeout(timer);
          ws.send(JSON.stringify({ type: 'ready', engineSource: cp.engineSource }));
          return;
        }
        if (!c.authed) { ws.close(4401, 'Authenticate first'); return; }
        if (m.type === 'subscribe') c.events = m.events === '*' ? '*' : new Set(m.events);
        else if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      });
    });
  }

  return { handleUpgrade, close: () => { clearInterval(ping); for (const c of clients) c.ws.close(1001, 'Server shutting down'); wss.close(); }, count: () => clients.size };
}
