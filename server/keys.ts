// Generates the control plane's secrets. Run once:  npm run server:keys > server/.env.local
// Prints the operator token ONCE (to stderr); only its scrypt hash goes in the env file.
import { randomBytes } from 'node:crypto';
import { hashOperatorToken } from './security';

const operatorToken = process.argv[2] ?? `whal_${randomBytes(24).toString('base64url')}`;
process.stderr.write(`\nOperator token (shown once, store it in a password manager):\n\n  ${operatorToken}\n\n`);
process.stdout.write([
  `WHAL_JWT_SECRET=${randomBytes(48).toString('base64')}`,
  `WHAL_MASTER_KEY=${randomBytes(32).toString('base64')}`,
  `WHAL_OPERATOR_TOKEN_HASH=${hashOperatorToken(operatorToken)}`,
  `WHAL_ENGINE_BRIDGE_TOKEN=${randomBytes(32).toString('base64url')}`,
  'WHAL_ENGINE_MODE=bridge',
  'WHAL_HOST=127.0.0.1',
  'WHAL_PORT=8787',
  'WHAL_CORS_ORIGINS=http://localhost:3000',
  '# WHAL_IP_ALLOWLIST=127.0.0.1/32,::1/128',
  '',
].join('\n'));
