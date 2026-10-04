import { setTimeout as wait } from "node:timers/promises";

/** Numeric seconds or an HTTP-date, as used by Retry-After; invalid values do not defer requests. */
export function retryDelayMs(value: string | null, now = Date.now()): number {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function waitForTurn(turn: Promise<void>, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Request aborted"));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    turn.then(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/** A process-local FIFO lane. Holds its slot through body consumption; cancelled waiters release theirs. */
export function createRequestGate() {
  let tail = Promise.resolve();
  let notBefore = 0;
  let lastStarted: number | undefined;
  return {
    defer(ms: number): void {
      if (Number.isFinite(ms) && ms > 0) notBefore = Math.max(notBefore, Date.now() + ms);
    },
    async run<T>(operation: () => Promise<T>, { signal, interval = 0 }: { signal?: AbortSignal; interval?: number } = {}): Promise<T> {
      const previous = tail;
      let release!: () => void;
      const slot = new Promise<void>(resolve => { release = resolve; });
      tail = previous.then(() => slot);
      try {
        await waitForTurn(previous, signal);
        if (lastStarted !== undefined) notBefore = Math.max(notBefore, lastStarted + interval);
        while (notBefore > Date.now()) await wait(Math.min(notBefore - Date.now(), 2_147_483_647), undefined, { signal });
        if (signal?.aborted) throw new Error("Request aborted");
        lastStarted = Date.now();
        notBefore = lastStarted + interval;
        const result = await operation();
        if (signal?.aborted) throw new Error("Request aborted");
        return result;
      } catch (error) {
        if (signal?.aborted) throw new Error("Request aborted");
        throw error;
      } finally {
        release();
      }
    },
  };
}
