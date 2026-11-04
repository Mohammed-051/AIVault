import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIX = path.join(REPO, 'tests', 'fixtures');

// A throwaway vault; must be created before importing engine modules (ROOT is read at import time).
export function tempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivault-test-'));
  process.env.AIVAULT_HOME = dir;
  return dir;
}
