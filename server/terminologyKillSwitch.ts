/**
 * Terminology kill switch — the operator-held emergency stop for the
 * native-terminology loop: vocabulary extraction + planner serving.
 *
 * Boundary (agreed scope): the stop freezes extraction entirely and removes
 * the governed canonical trial/proven atoms from planning — it is not a
 * whole-planner halt. Legacy tier-2 learned vocabulary and organic candidate
 * queries remain eligible in query generation, and evidence-driven
 * attribution/lifecycle refresh continues.
 *
 * Semantics (agreed before activation):
 * - Default-ON: the loop runs unless `app_settings.terminology_kill_switch`
 *   holds the exact value `'true'` (trimmed, case-insensitive). Missing or any
 *   other value means "run".
 * - Failure-safe: if the settings read itself fails, the loop KEEPS RUNNING
 *   (the agreed default-ON state) and the failure is logged at warn level.
 *   A transient settings-read error must not silently stop or kill serving;
 *   the switch is a deliberate operator action, not a dependency the pipeline
 *   can be denied by an unrelated error. Trade-off: during a settings outage
 *   an operator cannot engage the stop until the read recovers.
 * - Toggle (existing machinery, no new table, no env variable):
 *     setAppSetting('terminology_kill_switch', 'true')  // stop
 *     setAppSetting('terminology_kill_switch', 'false') // run
 *
 * Read by:
 * - extraction path: `extractVocabularyFromCreator` (hard no-op while active)
 * - planner path: `getPlannerTerminology` (returns no atoms while active)
 */
import { getAppSetting } from './dbCore';

export const TERMINOLOGY_KILL_SWITCH_KEY = 'terminology_kill_switch';

export interface TerminologyKillSwitchDeps {
  /** Injectable settings reader; defaults to the app_settings wrapper. */
  readSetting?: (key: string) => Promise<string>;
}

/** Shared failure-safe evaluation: only the exact value `'true'` stops. */
async function readSwitch(read: () => Promise<string>): Promise<boolean> {
  try {
    const value = await read();
    return String(value).trim().toLowerCase() === 'true';
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[Terminology Kill Switch] app_settings read failed; default-ON — loop continues: ${msg.slice(0, 160)}`
    );
    return false;
  }
}

/** True only when the setting is explicitly the value `'true'`. */
export async function isTerminologyKillSwitchActive(deps?: TerminologyKillSwitchDeps): Promise<boolean> {
  const read = deps?.readSetting ?? ((key: string) => getAppSetting(key, ''));
  return readSwitch(() => read(TERMINOLOGY_KILL_SWITCH_KEY));
}

/**
 * Same semantics, read through a caller-supplied queryable instead of the app
 * pool. Callers that deliberately pass their own client (e.g. read-only or
 * staging tooling that must not initialize the app pool's migration/seed
 * bootstrap) keep that guarantee for the switch read too. When that client is
 * inside a transaction, the read is confined to a savepoint so a failed
 * settings read cannot abort the caller's transaction and break the
 * failure-safe contract ("current transaction is aborted" on the next query).
 */
export async function isTerminologyKillSwitchActiveOn(queryable: {
  query: (sql: string, params?: any[]) => Promise<any>;
}): Promise<boolean> {
  return readSwitch(async () => {
    // Inside a transaction block any statement error aborts the transaction and
    // every later statement fails with "current transaction is aborted", which
    // would poison the caller's transaction. Outside a transaction block
    // PostgreSQL rejects SAVEPOINT ("can only be used in transaction blocks"),
    // so the attempt simply falls back to a plain read — autocommit statement
    // failures do not poison later statements.
    const savepointed = await queryable.query('SAVEPOINT terminology_kill_switch').then(
      () => true,
      () => false
    );
    try {
      const result = await queryable.query(
        `SELECT setting_value FROM app_settings WHERE setting_key=$1`,
        [TERMINOLOGY_KILL_SWITCH_KEY]
      );
      if (savepointed) {
        await queryable.query('RELEASE SAVEPOINT terminology_kill_switch').catch(() => undefined);
      }
      return String(result?.rows?.[0]?.setting_value ?? '');
    } catch (e) {
      if (savepointed) {
        await queryable.query('ROLLBACK TO SAVEPOINT terminology_kill_switch').catch(() => undefined);
      }
      throw e;
    }
  });
}
