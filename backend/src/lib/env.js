/**
 * Load .env from the repo root.
 *
 * `import 'dotenv/config'` resolves .env against the current working directory,
 * and npm workspace scripts run with cwd set to `backend/` — so the root .env
 * was silently invisible and every key looked unset. Resolve the path from this
 * module's own location instead of the caller's cwd, and the same file works
 * whether a script is started from the repo root, from backend/, or by npm.
 *
 * Import this once at the top of any entry point, before reading process.env.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));           // backend/src/lib
const candidates = [
  path.resolve(here, '../../../.env'), // repo root — where .env actually lives
  path.resolve(here, '../../.env'),    // backend/.env, if someone puts one there
];

for (const file of candidates) {
  if (fs.existsSync(file)) dotenv.config({ path: file, quiet: true });
}

export const ENV_FILES_LOADED = candidates.filter((f) => fs.existsSync(f));
