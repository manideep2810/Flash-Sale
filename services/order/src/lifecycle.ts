import type { Logger } from "@flash/observability";

/** Upper bound on letting in-flight handlers finish during shutdown. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Stops things in order, each given what is left of the budget. A stopper that throws or runs out of
 * time is logged and the rest still run: shutdown must reach the disconnects (Redis, Prisma) either way.
 */
export async function stopAll(
  logger: Logger,
  stoppers: [name: string, stop: () => Promise<void>][],
  budgetMs = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (const [name, stop] of stoppers) {
    const left = Math.max(deadline - Date.now(), 0);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        stop(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${budgetMs}ms budget`)), left);
        }),
      ]);
      logger.info("stopped", { component: name });
    } catch (error) {
      logger.error("stopping failed", { component: name, error: String(error) });
    } finally {
      clearTimeout(timer);
    }
  }
}
