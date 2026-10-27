const DEBUG_ENABLED =
  process.env.BOSS_CLI_DEBUG === '1' || process.env.BOSS_CLI_DEBUG === 'true';

export function bossDebug(message: string, details?: unknown): void {
  if (!DEBUG_ENABLED) return;
  let suffix = '';
  if (details !== undefined) {
    try {
      suffix = ` ${JSON.stringify(details)}`;
    } catch {
      suffix = ' [details-unserializable]';
    }
  }
  console.error(`[boss-cli][debug] ${message}${suffix}`);
}

let timingSequence = 0;

export function bossTimingStart(stage: string): (status?: string) => void {
  if (process.env.BOSS_CLI_TIMING !== 'true') return () => {};
  const started = performance.now();
  const span_id = `${process.pid}-${++timingSequence}`;
  const emit = (status: string) => console.error('[boss-cli][timing] ' + JSON.stringify({
    stage, status, span_id, time: new Date().toISOString(), pid: process.pid,
    elapsed_seconds: (performance.now() - started) / 1000,
  }));
  emit('start');
  return (status = 'complete') => emit(status);
}

/** Timings contain only fixed stage names, never page text or command arguments. */
export async function bossTimed<T>(stage: string, action: () => Promise<T>): Promise<T> {
  const finish = bossTimingStart(stage);
  try {
    const result = await action();
    finish();
    return result;
  } catch (error) {
    finish('failed');
    throw error;
  }
}
