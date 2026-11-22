// Writes config/bot-config.schema.json from the Zod schema. Run: npm run config:schema
import { writeFileSync } from 'node:fs';
import { toJsonSchema } from '../lib/config/schema';

const schema = { $id: 'https://whal.bot/schemas/bot-config.schema.json', title: 'Whal Bot configuration', ...toJsonSchema() };
writeFileSync(new URL('../config/bot-config.schema.json', import.meta.url), JSON.stringify(schema, null, 2) + '\n');
console.log('wrote config/bot-config.schema.json');
