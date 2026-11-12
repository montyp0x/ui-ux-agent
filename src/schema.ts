import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { suiteSchema } from './contracts.js';
import { resultSchema } from './results.js';

await mkdir('schemas', { recursive: true });
await writeFile(
  'schemas/suite.schema.json',
  JSON.stringify(z.toJSONSchema(suiteSchema), null, 2) + '\n',
);
console.log('Generated schemas/suite.schema.json');
// The result.json / results.json[] contract, for consumers outside this repo.
await writeFile(
  'schemas/result.schema.json',
  JSON.stringify(z.toJSONSchema(resultSchema), null, 2) + '\n',
);
console.log('Generated schemas/result.schema.json');
