import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideExclusionAuditRowAction,
  fetchExclusionAuditBatch,
  type ExclusionAuditBatchRow,
  type ExclusionAuditCursor
} from './queueManager';

interface FakeRow extends ExclusionAuditBatchRow {
  country_status: string;
}

const pad6 = (n: number): string => String(n).padStart(6, '0');
// PostgreSQL timestamptz text rendering: fixed-width microseconds + offset,
// so lexicographic order matches chronological order.
const seenAt = (micros: number): string => `2026-09-10 05:51:35.${pad6(micros)}+00`;

// In-memory stand-in for PostgreSQL keyset semantics: scope predicate,
// tuple comparison on (first_seen, channel_id), deterministic order, LIMIT.
function fakeDb(rows: FakeRow[], scope: 'audit' | 'rejected-cleanup') {
  const seenSql: string[] = [];
  const seenParams: unknown[][] = [];
  const ordered = [...rows].sort((a, b) =>
    a.cursor_seen < b.cursor_seen ? 1 : a.cursor_seen > b.cursor_seen ? -1 : b.channel_id.localeCompare(a.channel_id)
  );
  return {
    seenSql,
    seenParams,
    query: async (sql: string, params: any[]) => {
      seenSql.push(sql);
      seenParams.push([...params]);
      const [cursorSeen, cursorId, limit] = params as [string | null, string, number];
      const eligible = ordered.filter(row => {
        if (scope === 'rejected-cleanup') {
          if (row.country_status !== 'REJECTED') return false;
          if (row.discord_status !== 'DEAD' && row.discord_status !== 'NON_TRADING' && row.discord_status !== 'UNCERTAIN') return false;
          if (row.discord_invite === null) return false;
        } else if (row.country_status === 'REJECTED') {
          return false;
        }
        if (cursorSeen === null) return true;
        if (row.cursor_seen !== cursorSeen) return row.cursor_seen < cursorSeen;
        return row.channel_id < cursorId;
      });
      const page = eligible.slice(0, limit);
      return { rows: page, rowCount: page.length };
    }
  };
}

function subMsRows(count: number): FakeRow[] {
  // All rows inside ONE JavaScript millisecond (micros 1..N): a cursor
  // rounded through Date/toISOString would collapse them and stop the walk.
  return Array.from({ length: count }, (_, i) => ({
    channel_id: `ch-${pad6(i)}`,
    channel_name: `Channel ${i}`,
    country: null,
    discord_status: 'ACTIVE',
    discord_invite: null,
    cursor_seen: seenAt(i + 1),
    country_status: 'CONFIRMED'
  }));
}

test('keyset cursor preserves sub-millisecond precision across batch boundaries', async () => {
  const db = fakeDb(subMsRows(25), 'audit');
  const visited: string[] = [];
  let cursor: ExclusionAuditCursor = { cursorSeen: null, cursorId: '' };
  for (;;) {
    const { rows, nextCursor } = await fetchExclusionAuditBatch(db, cursor, 7, 'audit');
    if (!rows.length) break;
    visited.push(...rows.map(row => row.channel_id));
    // The cursor handed to the next query is byte-identical to the
    // PostgreSQL-rendered value — six-digit microseconds intact, never
    // rounded through JavaScript Date millisecond precision.
    if (!nextCursor || rows.length < 7) break;
    assert.match(nextCursor.cursorSeen!, /\.\d{6}\+00$/);
    cursor = nextCursor;
  }
  assert.equal(visited.length, 25);
  assert.deepEqual(visited, [...visited].sort().reverse());
  assert.equal(new Set(visited).size, 25);
  for (const params of db.seenParams.slice(1)) {
    assert.match(String(params[0]), /\.\d{6}\+00$/);
  }
});

test('batch SQL uses exact-text cursor, tie-breaker, and narrow columns', async () => {
  const db = fakeDb(subMsRows(3), 'audit');
  await fetchExclusionAuditBatch(db, { cursorSeen: null, cursorId: '' }, 200, 'audit');
  const sql = db.seenSql[0];
  assert.match(sql, /first_seen::text AS cursor_seen/);
  assert.match(sql, /\(first_seen, channel_id\) < \(\$1::timestamptz, \$2::text\)/);
  assert.match(sql, /ORDER BY first_seen DESC, channel_id DESC/);
  assert.match(sql, /country_status IS DISTINCT FROM 'REJECTED'/);
  assert.doesNotMatch(sql, /SELECT \*/);
});

test('rejected-cleanup scope visits only invite-cleanup-eligible REJECTED rows', async () => {
  const rows: FakeRow[] = [
    { channel_id: 'r1', channel_name: 'R1', country: null, discord_status: 'DEAD', discord_invite: 'https://discord.gg/a', cursor_seen: seenAt(30), country_status: 'REJECTED' },
    { channel_id: 'r2', channel_name: 'R2', country: null, discord_status: 'ACTIVE', discord_invite: 'https://discord.gg/b', cursor_seen: seenAt(20), country_status: 'REJECTED' },
    { channel_id: 'r3', channel_name: 'R3', country: null, discord_status: 'NON_TRADING', discord_invite: null, cursor_seen: seenAt(10), country_status: 'REJECTED' },
    { channel_id: 'c1', channel_name: 'C1', country: null, discord_status: 'DEAD', discord_invite: 'https://discord.gg/c', cursor_seen: seenAt(40), country_status: 'CONFIRMED' }
  ];
  const db = fakeDb(rows, 'rejected-cleanup');
  const visited: string[] = [];
  let cursor: ExclusionAuditCursor = { cursorSeen: null, cursorId: '' };
  for (;;) {
    const { rows: page, nextCursor } = await fetchExclusionAuditBatch(db, cursor, 200, 'rejected-cleanup');
    if (!page.length) break;
    visited.push(...page.map(row => row.channel_id));
    if (!nextCursor || page.length < 200) break;
    cursor = nextCursor;
  }
  assert.deepEqual(visited, ['r1']);
  assert.match(db.seenSql[0], /country_status = 'REJECTED'/);
});

test('already-REJECTED rows with stale invites take invite-cleanup, status preserved', () => {
  for (const discordStatus of ['DEAD', 'NON_TRADING', 'UNCERTAIN']) {
    assert.equal(
      decideExclusionAuditRowAction({ alreadyRejected: true, validationStatus: 'UNCERTAIN', discordStatus, discordInvite: 'https://discord.gg/abc' }),
      'invite-cleanup'
    );
  }
  // A REJECTED validation on an already-rejected row only re-stamps; dropped.
  assert.equal(
    decideExclusionAuditRowAction({ alreadyRejected: true, validationStatus: 'REJECTED', discordStatus: 'DEAD', discordInvite: 'https://discord.gg/abc' }),
    'none'
  );
  assert.equal(
    decideExclusionAuditRowAction({ alreadyRejected: true, validationStatus: 'LIKELY', discordStatus: 'ACTIVE', discordInvite: 'https://discord.gg/abc' }),
    'none'
  );
  assert.equal(
    decideExclusionAuditRowAction({ alreadyRejected: true, validationStatus: 'UNCERTAIN', discordStatus: 'DEAD', discordInvite: null }),
    'none'
  );
});

test('non-rejected country audit behavior is unchanged', () => {
  assert.equal(
    decideExclusionAuditRowAction({ alreadyRejected: false, validationStatus: 'REJECTED', discordStatus: 'ACTIVE', discordInvite: null }),
    'reject-write'
  );
  assert.equal(
    decideExclusionAuditRowAction({ alreadyRejected: false, validationStatus: 'UNCERTAIN', discordStatus: 'DEAD', discordInvite: 'https://discord.gg/abc' }),
    'invite-cleanup'
  );
  assert.equal(
    decideExclusionAuditRowAction({ alreadyRejected: false, validationStatus: 'CONFIRMED', discordStatus: 'ACTIVE', discordInvite: null }),
    'none'
  );
  assert.equal(
    decideExclusionAuditRowAction({ alreadyRejected: false, validationStatus: 'LIKELY', discordStatus: 'UNCERTAIN', discordInvite: null }),
    'none'
  );
});
