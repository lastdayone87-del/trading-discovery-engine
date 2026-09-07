/* Rebuild the POC dataset cache via read-only production SELECTs.
 *
 * Reads label tiers from labels/*.txt and fetches the latest normalized_input
 * per channel plus statuses. Writes labels/dataset_cache.json (git-ignored:
 * human-adjacent evaluation material must not be published raw).
 *
 * Requires PGUSER/PGPASSWORD/PGHOST/PGPORT/PGDATABASE env (read-only auditor).
 * Usage: node fetch_dataset.js [output_path]
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('/root/projects/trading-discovery-engine/node_modules/pg');

const HERE = __dirname;
function readIds(name) {
  return fs.readFileSync(path.join(HERE, 'labels', name), 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

(async () => {
  const outPath = process.argv[2] || path.join(HERE, 'labels', 'dataset_cache.json');
  const c = new Client({
    user: process.env.PGUSER, password: process.env.PGPASSWORD,
    host: process.env.PGHOST, port: +process.env.PGPORT, database: process.env.PGDATABASE,
    ssl: { rejectUnauthorized: false }, statement_timeout: 60000, connectionTimeoutMillis: 25000,
  });
  await c.connect();
  const positives = readIds('positives.txt');
  const negatives = readIds('negatives.txt');
  const excluded = new Set(readIds('exclude.txt'));
  const ids = [...new Set([...positives, ...negatives])].filter(id => !excluded.has(id));
  const r = await c.query(
    `WITH latest AS (SELECT DISTINCT ON (channel_id) channel_id, normalized_input
       FROM production_classification_diagnostics ORDER BY channel_id, created_at DESC)
     SELECT l.channel_id, ch.trading_status,
       (SELECT d.decision FROM channel_review_decisions d
         WHERE d.channel_id=l.channel_id ORDER BY d.review_version DESC LIMIT 1) AS human_decision,
       l.normalized_input AS input
     FROM latest l JOIN channels ch ON ch.channel_id=l.channel_id
     WHERE l.channel_id = ANY($1)
        OR (ch.trading_status IN ('NON_TRADING','HUMAN_REJECTED')
            AND length(l.normalized_input->>'description') >= 50)`,
    [ids]);
  const posSet = new Set(positives), negSet = new Set(negatives);
  const rows = r.rows.map(x => ({
    ...x,
    user_confirmed_trading: posSet.has(x.channel_id) && !negSet.has(x.channel_id),
    human_negative: negSet.has(x.channel_id),
  }));
  await c.end();
  fs.writeFileSync(outPath, JSON.stringify(rows));
  const missing = ids.filter(id => !rows.some(r => r.channel_id === id));
  console.log(`rows: ${rows.length}, labeled ids missing inputs: ${missing.length}`, missing.slice(0, 10));
})().catch(e => { console.log('FAIL:', e.message); process.exit(1); });
