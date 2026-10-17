/**
 * Terminology kill switch — the single operator-held emergency stop for the
 * native-terminology loop (vocabulary extraction + planner serving).
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

/** True only when the setting is explicitly the value `'true'`. */
export async function isTerminologyKillSwitchActive(deps?: TerminologyKillSwitchDeps): Promise<boolean> {
  const read = deps?.readSetting ?? ((key: string) => getAppSetting(key, ''));
  try {
    const value = await read(TERMINOLOGY_KILL_SWITCH_KEY);
    return String(value).trim().toLowerCase() === 'true';
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[Terminology Kill Switch] app_settings read failed; default-ON — loop continues: ${msg.slice(0, 160)}`
    );
    return false;
  }
}
