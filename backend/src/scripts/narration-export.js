/**
 * Freeze the LLM narration into a committed file.
 *
 * Deployed environments have ephemeral disks — Render rebuilds the database on
 * every boot from the (deterministic) seed. Re-narrating there would mean 80 API
 * calls and ~25 minutes on a start command that must finish in seconds, so the
 * prose is exported here, committed, and replayed at boot instead.
 *
 * Keyed by case id + sequence, which are stable as long as SEED and SEED_NOW are
 * pinned — the same guarantee the rest of the demo already relies on.
 *
 *   npm run narrate:export
 */
import '../lib/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db/index.js';
import { PROVIDER, MODEL } from '../engine/llm-narrator.js';

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'narration.json');

const db = getDb();

const audit = db.prepare(`
  SELECT case_id, sequence, reasoning_text FROM audit_entries
  WHERE reasoning_source = 'llm' ORDER BY case_id, sequence`).all();

// Only messages on cases the narrator actually reached; the rest are templates.
const messages = db.prepare(`
  SELECT l.case_id, l.sequence, l.message_sent FROM intervention_logs l
  WHERE l.message_sent IS NOT NULL
    AND l.case_id IN (SELECT DISTINCT case_id FROM audit_entries WHERE reasoning_source = 'llm')
  ORDER BY l.case_id, l.sequence`).all();

const payload = {
  generatedAt: new Date().toISOString(),
  provider: PROVIDER,
  model: MODEL,
  seed: Number(process.env.SEED) || 20260829,
  seedNow: process.env.SEED_NOW ?? null,
  counts: { audit: audit.length, messages: messages.length },
  audit: audit.map((a) => [a.case_id, a.sequence, a.reasoning_text]),
  messages: messages.map((m) => [m.case_id, m.sequence, m.message_sent]),
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);

console.log(`\n  Exported ${payload.counts.audit} reasoning strings and ${payload.counts.messages} messages`);
console.log(`  ${payload.provider} · ${payload.model}`);
console.log(`  -> ${OUT} (${kb} KB)`);
console.log(`\n  Commit this file so deployments get LLM prose without calling the API.\n`);
