// Cross-platform test runner: one process per file (Node 18+; no glob support needed).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--test', path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} test file(s) failed` : `\nAll ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
