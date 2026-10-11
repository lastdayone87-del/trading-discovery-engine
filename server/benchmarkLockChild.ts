// Test-only driver for cross-process lock contention tests. Executed in
// forked child processes (never loaded as a test itself): the parent
// sequences lock operations across real OS processes via IPC, so races and
// pid semantics are genuine — no baud-rate timing, no shared memory.
//
// Protocol (parent -> child { id, cmd, ... }, child -> parent { id, ... }):
//   acquire { outDir }            -> { ok, token } | { ok:false, error }
//   acquirePlan { lockPath }      -> { ok, token } | { ok:false, error }
//   inspect { lockPath, tag }     -> { ok, outcome } (intent kept by id)
//   commit { id }                 -> { ok, result } | { ok:false, error }
//   abandon { id }                -> { ok }
//   release { id }                -> { ok, released }
//   assertOwned { id }            -> { ok } | { ok:false, error }
//   exit {}                       -> child terminates (no reply)
import {
  acquireBenchmarkExecutionLock,
  acquirePlanExecutionLock,
  inspectStaleLock,
  type BenchmarkExecutionLock,
  type PendingStaleRecovery,
} from './benchmarkExecutionLock';

interface Entry {
  handle?: BenchmarkExecutionLock;
  recovery?: PendingStaleRecovery;
}

const held = new Map<string, Entry>();

function entryKey(msg: { id: number; key?: string }): string {
  return typeof msg.key === 'string' && msg.key ? msg.key : String(msg.id);
}

function reply(id: unknown, payload: Record<string, unknown>): void {
  if (process.send) process.send({ id, ...payload });
}

process.on('message', (raw) => {
  const msg = raw as { id: number; key?: string; cmd: string; outDir?: string; lockPath?: string; tag?: string };
  try {
    switch (msg.cmd) {
      case 'acquire': {
        const handle = acquireBenchmarkExecutionLock(msg.outDir as string);
        held.set(entryKey(msg), { handle });
        reply(msg.id, { ok: true, token: handle.token });
        break;
      }
      case 'acquirePlan': {
        const handle = acquirePlanExecutionLock(msg.lockPath as string);
        held.set(entryKey(msg), { handle });
        reply(msg.id, { ok: true, token: handle.token });
        break;
      }
      case 'inspect': {
        const inspection = inspectStaleLock(msg.lockPath as string, msg.tag as string);
        if (inspection.outcome === 'recoverable') {
          held.set(entryKey(msg), { recovery: inspection.recovery });
          reply(msg.id, { ok: true, outcome: 'recoverable' });
        } else if (inspection.outcome === 'live') {
          reply(msg.id, { ok: true, outcome: 'live', pid: inspection.info.pid });
        } else {
          reply(msg.id, { ok: true, outcome: inspection.outcome });
        }
        break;
      }
      case 'commit': {
        const entry = held.get(entryKey(msg));
        if (!entry?.recovery) {
          reply(msg.id, { ok: false, error: 'NO_RECOVERY' });
          break;
        }
        try {
          reply(msg.id, { ok: true, result: entry.recovery.commit() });
        } catch (error) {
          reply(msg.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        break;
      }
      case 'abandon': {
        held.get(entryKey(msg))?.recovery?.abandon();
        held.delete(entryKey(msg));
        reply(msg.id, { ok: true });
        break;
      }
      case 'release': {
        const entry = held.get(entryKey(msg));
        held.delete(entryKey(msg));
        reply(msg.id, { ok: true, released: entry?.handle ? entry.handle.release() : false });
        break;
      }
      case 'assertOwned': {
        const entry = held.get(entryKey(msg));
        try {
          entry?.handle?.assertOwned();
          reply(msg.id, { ok: entry?.handle ? true : false });
        } catch (error) {
          reply(msg.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        break;
      }
      case 'exit': {
        process.exit(0);
        break;
      }
      default: {
        reply(msg.id, { ok: false, error: `UNKNOWN_CMD:${msg.cmd}` });
      }
    }
  } catch (error) {
    reply(msg.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

if (process.send) process.send({ ready: true });
