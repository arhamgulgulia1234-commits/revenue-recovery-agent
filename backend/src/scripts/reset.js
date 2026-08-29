import '../lib/env.js';
import { resetDb, DB_PATH } from '../db/index.js';

const dropped = resetDb();
console.log(`✓ Reset ${dropped.length} tables in ${DB_PATH}`);
