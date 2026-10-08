import type { Logger } from "@flash/observability";

/**
 * Runs `task` every `intervalMs`. A run still in flight when the next tick fires is not doubled up,
 * and a run that throws is logged without stopping the schedule. Returns a function that cancels it.
 */
export function every(
  intervalMs: number,
  name: string,
  logger: Logger,
  task: () => Promise<void>,
): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await task();
    } catch (error) {
      logger.error(`${name} failed`, error);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
