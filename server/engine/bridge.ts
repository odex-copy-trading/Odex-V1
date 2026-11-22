// Bridge for the real (Rust) engine. The engine connects OUT to the control plane:
//   ws://<control-plane>/internal/engine   with header  Authorization: Bearer <WHAL_ENGINE_BRIDGE_TOKEN>
// Engine -> control plane:  {type:"snapshot", runtime: EngineRuntime}
//                           {type:"event", event: TelemetryEvent | {type:"nonces", nonces}}
//                           {type:"ack", id, ok, error?, fields?, result?}
// Control plane -> engine:  {type:"command", id, command: EngineCommand}
// One engine connection at a time; a second connection replaces the first.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { EngineError, type AdapterEvent, type EngineAdapter, type EngineCommand, type EngineRuntime } from './types';

export class BridgeEngine implements EngineAdapter {
  readonly source = 'bridge' as const;
  private ws: WebSocket | null = null;
  private rt: EngineRuntime | null = null;
  private listeners: ((e: AdapterEvent) => void)[] = [];
  private pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  private seq = 0;

  constructor(private token: string) {}
  start() {}
  stop() { this.ws?.close(1001); this.wss.close(); }
  runtime() { return this.rt ? structuredClone(this.rt) : null; }
  onEvent(cb: (e: AdapterEvent) => void) { this.listeners.push(cb); }
  private emit(e: AdapterEvent) { for (const l of this.listeners) l(e); }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(this.token);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.ws?.close(4000, 'Replaced by a new engine connection');
      this.ws = ws;
      ws.on('message', (raw) => this.onMessage(String(raw)));
      ws.on('close', (_code, reason) => {
        if (this.ws !== ws) return;
        this.ws = null; this.rt = null;
        for (const p of this.pending.values()) p.reject(new EngineError('Engine disconnected', 503));
        this.pending.clear();
        this.emit({ type: 'disconnected', reason: String(reason) || 'socket closed' });
      });
    });
  }

  private onMessage(raw: string) {
    let m: { type: string; [k: string]: unknown };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'snapshot') { this.rt = m.runtime as EngineRuntime; this.emit({ type: 'connected' }); return; }
    if (m.type === 'event' && this.rt) { this.emit(m.event as AdapterEvent); return; }
    if (m.type === 'ack') {
      const p = this.pending.get(String(m.id));
      if (!p) return;
      this.pending.delete(String(m.id));
      if (m.ok) p.resolve(m.result);
      else p.reject(Object.assign(new EngineError(String(m.error ?? 'Rejected by engine'), 422), { fields: m.fields }));
    }
  }

  command<R>(cmd: EngineCommand): Promise<R> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.rt) return Promise.reject(new EngineError('Engine not connected', 503));
    const id = `b${++this.seq}`;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new EngineError('Engine did not acknowledge in time', 504)); }, 5000);
      ws.send(JSON.stringify({ type: 'command', id, command: cmd }));
    });
  }
}
