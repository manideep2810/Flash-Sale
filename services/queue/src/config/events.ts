import { z } from "zod";
import { QueueUnavailableError, type Redis } from "../redis/client.js";
import { configKey } from "../redis/keys.js";

export const DEFAULT_ADMIT_RATE_PER_SEC = 500;
export const DEFAULT_ADMIT_TTL_SEC = 120;

const CACHE_TTL_MS = 5_000;

// Hash fields arrive as strings. The two defaults apply when a field is absent from the hash.
const configSchema = z.object({
  /** Epoch ms. Before this, join answers NOT_OPEN. */
  lobbyOpensAt: z.coerce.number().int().min(0),
  /** Epoch ms. Joins before this draw a lottery number; the admitter starts at this instant. */
  saleOpensAt: z.coerce.number().int().min(0),
  // At least 1: the admitter's allowance is capped at one second's worth, so a rate below 1 would
  // never add up to a whole admission.
  admitRatePerSec: z.coerce.number().min(1).default(DEFAULT_ADMIT_RATE_PER_SEC),
  /** How long an admitted user's turn (and the token minted for it) lasts. */
  admitTtlSec: z.coerce.number().int().min(1).default(DEFAULT_ADMIT_TTL_SEC),
  /** What the event page calls the event. Display only; the event id stands in when it is absent. */
  name: z.string().min(1).optional(),
  /**
   * Per ticket, in the smallest currency unit. Display only here. The order service reads the same
   * field when an order is paid for, and charges it times the quantity.
   */
  price: z.coerce.number().int().min(0).optional(),
});

export interface EventConfig extends z.infer<typeof configSchema> {
  eventId: string;
}

/** The event's config hash exists but does not parse. A seeding mistake, not a missing event. */
export class InvalidEventConfigError extends Error {
  constructor(eventId: string, detail: string) {
    super(`event "${eventId}" has an invalid config hash:\n${detail}`);
    this.name = "InvalidEventConfigError";
  }
}

export interface EventConfigs {
  /** Null when the event has no config hash, i.e. no waiting room. */
  get(eventId: string): Promise<EventConfig | null>;
}

/**
 * Event config from the ev:<eventId>:config hash, cached per event for five seconds.
 *
 * Only events that exist stay cached. A miss or a failed read is dropped as soon as it settles, so a
 * newly seeded event is visible on the next request and unknown ids from the URL cannot grow the map.
 */
export function createEventConfigs(
  redis: Redis,
  { ttlMs = CACHE_TTL_MS }: { ttlMs?: number } = {},
): EventConfigs {
  const cache = new Map<string, { loadedAt: number; config: Promise<EventConfig | null> }>();

  async function load(eventId: string): Promise<EventConfig | null> {
    let fields: Record<string, string>;
    try {
      fields = await redis.hgetall(configKey(eventId));
    } catch (error) {
      throw new QueueUnavailableError(error);
    }
    // HGETALL of a missing key is an empty hash, not an error.
    if (Object.keys(fields).length === 0) {
      return null;
    }
    const parsed = configSchema.safeParse(fields);
    if (!parsed.success) {
      throw new InvalidEventConfigError(eventId, z.prettifyError(parsed.error));
    }
    return { eventId, ...parsed.data };
  }

  return {
    get(eventId) {
      const hit = cache.get(eventId);
      if (hit && Date.now() - hit.loadedAt < ttlMs) {
        return hit.config;
      }
      // The promise is cached, not its value, so a burst of requests on expiry shares one read.
      const config = load(eventId);
      cache.set(eventId, { loadedAt: Date.now(), config });
      const forget = () => {
        if (cache.get(eventId)?.config === config) {
          cache.delete(eventId);
        }
      };
      config.then((found) => {
        if (!found) {
          forget();
        }
      }, forget);
      return config;
    },
  };
}
