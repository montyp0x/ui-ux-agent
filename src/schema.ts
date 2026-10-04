import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { suiteSchema } from './contracts.js';

await mkdir('schemas', { recursive: true });
await writeFile(
  'schemas/suite.schema.json',
  JSON.stringify(z.toJSONSchema(suiteSchema), null, 2) + '\n',
);
console.log('Generated schemas/suite.schema.json');
