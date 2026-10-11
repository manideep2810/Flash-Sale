import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/prisma/client.js";

/** One event as the catalogue holds it: a row of the Event table (prisma/schema.prisma). */
export interface EventRecord {
  /** A slug. It is in the event's URL, its Redis keys and every hold id, so it never changes. */
  id: string;
  name: string;
  description: string;
  /** Per ticket, in the smallest currency unit. */
  price: number;
  /** Tickets put on sale. Set once, when the event is created. */
  totalStock: number;
  imageUrl: string | null;
  lobbyOpensAt: Date;
  saleOpensAt: Date;
  admitRatePerSec: number;
  admitTtlSec: number;
  createdAt: Date;
  updatedAt: Date;
}

export type NewEvent = Omit<EventRecord, "createdAt" | "updatedAt">;

/** What an edit may change. The id and the stock are fixed once the event exists. */
export type EventChanges = Partial<Omit<NewEvent, "id" | "totalStock">>;

/** create() was given an id another event already has. */
export class EventExistsError extends Error {
  constructor(id: string) {
    super(`an event with the id "${id}" already exists`);
    this.name = "EventExistsError";
  }
}

export interface EventStore {
  /** Every event, soonest sale first. */
  list(): Promise<EventRecord[]>;
  get(id: string): Promise<EventRecord | null>;
  /** Rejects with EventExistsError when the id is taken. */
  create(event: NewEvent): Promise<EventRecord>;
  /** Null when there is no such event. */
  update(id: string, changes: EventChanges): Promise<EventRecord | null>;
  /** Only to undo a create() whose Redis half then failed. */
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * The catalogue is read on page loads and written by one admin: a few connections are plenty, and
 * every cluster worker opens this pool beside the baseline one, so it is kept small.
 */
const POOL_MAX = 3;

const isPrismaError = (error: unknown, code: string): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;

/** The catalogue in Postgres, through Prisma. */
export function createEventStore(databaseUrl: string): EventStore {
  // node-postgres does not act on the `?schema=` parameter of Prisma's URL format, so the schema is
  // read out of the URL and handed to the adapter (as in services/order/src/db.ts).
  const schema = new URL(databaseUrl).searchParams.get("schema") ?? undefined;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, max: POOL_MAX }, { schema }),
  });

  return {
    list: () => prisma.event.findMany({ orderBy: [{ saleOpensAt: "asc" }, { id: "asc" }] }),
    get: (id) => prisma.event.findUnique({ where: { id } }),
    async create(event) {
      try {
        return await prisma.event.create({ data: event });
      } catch (error) {
        // P2002: unique constraint, which here can only be the primary key.
        if (isPrismaError(error, "P2002")) {
          throw new EventExistsError(event.id);
        }
        throw error;
      }
    },
    async update(id, changes) {
      try {
        return await prisma.event.update({ where: { id }, data: changes });
      } catch (error) {
        // P2025: the row to update was not found.
        if (isPrismaError(error, "P2025")) {
          return null;
        }
        throw error;
      }
    },
    async remove(id) {
      await prisma.event.deleteMany({ where: { id } });
    },
    close: () => prisma.$disconnect(),
  };
}
