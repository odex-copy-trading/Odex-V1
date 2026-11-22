// Control plane entry point.  npm run server            (needs the env vars in server/README.md)
//                             npm run server:keys       (generate secrets + operator token)
import { createApp } from './app';
import { ControlPlane } from './control';
import { Db } from './db';
import { loadEnv } from './env';
import { SecretStore } from './secrets';
import { BridgeEngine } from './engine/bridge';
import { SimulatedEngine } from './engine/simulated';
import { SolanaLiveFeed } from './engine/solana-feed';
import type { EngineAdapter } from './engine/types';

async function main() {
  const env = loadEnv();
  const db = new Db(env.dbPath);
  const secrets = new SecretStore(env.secretsPath, env.masterKey);

  let engine: EngineAdapter;
  let bridge: BridgeEngine | null = null;
  let seed: ReturnType<SimulatedEngine['seed']> | undefined;
  if (env.engineMode === 'bridge') {
    engine = bridge = new BridgeEngine(env.engineBridgeToken!);
  } else {
    const sim = new SimulatedEngine();
    seed = sim.seed();
    engine = sim;
  }

  const cp = new ControlPlane(db, secrets, engine, seed);
  engine.onEvent((e) => { if (e.type === 'connected') cp.syncEngine().catch((err) => console.error('[engine] sync failed', err)); });
  engine.start();
  if (env.engineMode === 'simulated') await cp.syncEngine();

  const liveFeed = env.engineMode === 'bridge' ? new SolanaLiveFeed(cp, secrets) : null;
  liveFeed?.start();

  const { server, close } = createApp(env, db, cp, bridge);
  setInterval(() => db.pruneRevoked(), 3_600_000).unref();
  server.listen(env.port, env.host, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'control plane listening', url: `http://${env.host}:${env.port}`, engine: env.engineMode, origins: env.corsOrigins, allowlist: env.ipAllowlist.length ? env.ipAllowlist : 'any' }));
    if (env.engineMode === 'simulated') console.log('[engine] SIMULATED engine: no RPC, no signing, no transactions.');
  });

  const shutdown = () => { console.log('shutting down'); liveFeed?.stop(); close(); engine.stop(); db.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error(`[fatal] ${e.message}`); process.exit(1); });
