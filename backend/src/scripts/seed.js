/**
 * Seeds the database with a fresh synthetic book of at-risk revenue.
 * Does NOT open recovery cases — that is the decision engine's job
 * (`npm run simulate`), so detection stays auditable and re-runnable.
 */
import '../lib/env.js';
import { getDb } from '../db/index.js';
import { generateDataset, summarize } from '../data/generator.js';

const inr = (n) => '₹' + n.toLocaleString('en-IN');

function seed(options = {}) {
  const db = getDb();
  const dataset = generateDataset(options);

  const insertCustomer = db.prepare(`
    INSERT INTO customers (id,name,segment,phone,email,reliability_score,lifetime_value_inr,
      timezone,salary_day,preferred_channel,opted_out_at,disputed_at,created_at)
    VALUES (@id,@name,@segment,@phone,@email,@reliability_score,@lifetime_value_inr,
      @timezone,@salary_day,@preferred_channel,@opted_out_at,@disputed_at,@created_at)`);

  const insertSub = db.prepare(`
    INSERT INTO subscriptions (id,customer_id,plan_name,amount_inr,frequency,status,
      mandate_type,started_at,next_billing_at)
    VALUES (@id,@customer_id,@plan_name,@amount_inr,@frequency,@status,
      @mandate_type,@started_at,@next_billing_at)`);

  const insertInvoice = db.prepare(`
    INSERT INTO invoices (id,customer_id,invoice_number,amount_inr,issued_at,due_at,status,po_number)
    VALUES (@id,@customer_id,@invoice_number,@amount_inr,@issued_at,@due_at,@status,@po_number)`);

  const insertAttempt = db.prepare(`
    INSERT INTO payment_attempts (id,customer_id,subscription_id,invoice_id,amount_inr,status,
      decline_code,gateway_message,attempt_number,channel,created_at)
    VALUES (@id,@customer_id,@subscription_id,@invoice_id,@amount_inr,@status,
      @decline_code,@gateway_message,@attempt_number,@channel,@created_at)`);

  const write = db.transaction((d) => {
    for (const c of d.customers) insertCustomer.run(c);
    for (const s of d.subscriptions) insertSub.run(s);
    for (const i of d.invoices) insertInvoice.run(i);
    for (const a of d.paymentAttempts) {
      const { _caseType, ...row } = a;
      insertAttempt.run(row);
    }
  });

  const existing = db.prepare('SELECT COUNT(*) n FROM customers').get().n;
  if (existing > 0) {
    console.error(`✗ Database already holds ${existing} customers. Run \`npm run reset\` first.`);
    process.exit(1);
  }

  write(dataset);
  return dataset;
}

const dataset = seed();
const s = summarize(dataset);

console.log(`\n  Synthetic dataset seeded  (seed=${dataset.seed})\n`);
console.log(`  Customers           ${s.customers}`);
console.log(`  Subscriptions       ${s.subscriptions}`);
console.log(`  B2B invoices        ${s.invoices}`);
console.log(`  Failed payments     ${s.failures}`);
console.log(`  Revenue at risk     ${inr(s.atRiskInr)}\n`);

console.log('  Failure mix by decline code');
for (const [code, n] of Object.entries(s.byCode).sort((a, b) => b[1] - a[1])) {
  const bar = '█'.repeat(Math.round((n / s.failures) * 60));
  console.log(`    ${code.padEnd(22)} ${String(n).padStart(3)}  ${bar}`);
}

console.log('\n  Case types');
for (const [type, n] of Object.entries(s.byType)) console.log(`    ${type.padEnd(22)} ${n}`);

console.log(`\n  Hard stops pre-set: ${s.optedOut} opted out, ${s.disputed} disputed`);
console.log('  Next: build the decision engine\n');
