import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyPacket } from './agentic-scale-proof-lib.mjs';

const input = resolve(process.argv[2] ?? 'docs/benchmarks/agentic-scale-proof/fixtures/proof-packet.json');
const packet = JSON.parse(await readFile(input, 'utf8'));
const result = verifyPacket(packet);
console.log(JSON.stringify({ implementation: 'javascript-node-stdlib', input, ...result }));
if (!result.valid) process.exitCode = 1;

