// Fills the catalogue with a handful of demo events, at different points of their lives, so the
// listing has something to show: one on sale now, one about to sell out, one whose lobby is open, one
// opening soon and one for another day.
//
//   pnpm -C tools run seed-events          (or: make seed)
//
// It goes through the ticket service's admin API, like the admin page does, so each event gets its
// row in Postgres, its stock in Redis and its waiting room. The admin session is minted here with
// SESSION_SECRET (the .env.example value unless the variable is set), which is why this only works
// against a local stack.
//
// Run it again and the events that already exist get their times moved (relative to now) and their
// details rewritten; their stock is NOT reset, because an event's stock is set once, when it is
// created.

import { bearer } from "./tokens.js";

const TICKET_URL = process.env.TICKET_URL ?? "http://localhost:3001";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Seed {
  id: string;
  name: string;
  description: string;
  /** In the smallest currency unit. */
  price: number;
  totalStock: number;
  /** From now, in ms. Negative is in the past. */
  lobbyOpensIn: number;
  saleOpensIn: number;
  admitRatePerSec: number;
}

const SEEDS: Seed[] = [
  {
    id: "aurora-sound-festival",
    name: "Aurora Sound Festival",
    description:
      "Three stages, forty artists and one very long night under the open sky. General admission, all stages, gates at 4 pm.",
    price: 349_900,
    totalStock: 500,
    lobbyOpensIn: -30 * MINUTE,
    saleOpensIn: -5 * MINUTE,
    admitRatePerSec: 50,
  },
  {
    id: "late-show-live",
    name: "The Late Show, Live",
    description:
      "An evening of stand-up in a 200-seat room. Five comics, one mic, no recording. The last few seats.",
    price: 99_900,
    totalStock: 8,
    lobbyOpensIn: -20 * MINUTE,
    saleOpensIn: -2 * MINUTE,
    admitRatePerSec: 20,
  },
  {
    id: "midnight-arena-tour",
    name: "Midnight Arena Tour: Opening Night",
    description:
      "The first night of the tour, the full production, floor and lower bowl. Join the lobby now: everyone in it gets a random place in line when the sale opens.",
    price: 499_900,
    totalStock: 1_000,
    lobbyOpensIn: -10 * MINUTE,
    saleOpensIn: 3 * MINUTE,
    admitRatePerSec: 100,
  },
  {
    id: "symphony-under-the-stars",
    name: "Symphony Under the Stars",
    description:
      "A full orchestra on the lakeside lawn, film scores from dusk until the fireworks. Bring a blanket.",
    price: 149_900,
    totalStock: 300,
    lobbyOpensIn: 10 * MINUTE,
    saleOpensIn: 20 * MINUTE,
    admitRatePerSec: 50,
  },
  {
    id: "indie-game-expo",
    name: "Indie Game Expo: Day One",
    description:
      "Two hundred playable games, the people who made them, and a hall that fills up fast. Day-one passes.",
    price: 79_900,
    totalStock: 2_000,
    lobbyOpensIn: 23 * HOUR,
    saleOpensIn: 24 * HOUR,
    admitRatePerSec: 200,
  },
];

async function seed(event: Seed, headers: Record<string, string>): Promise<string> {
  const now = Date.now();
  const details = {
    name: event.name,
    description: event.description,
    price: event.price,
    // A stand-in photo, the same one every time for the same id. Replace it from the admin page.
    imageUrl: `https://picsum.photos/seed/${event.id}/1200/750`,
    lobbyOpensAt: now + event.lobbyOpensIn,
    saleOpensAt: now + event.saleOpensIn,
    admitRatePerSec: event.admitRatePerSec,
  };

  const created = await fetch(`${TICKET_URL}/admin/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: event.id, totalStock: event.totalStock, ...details }),
  });
  if (created.status === 201) {
    return `created  ${event.id}  (${event.totalStock} tickets)`;
  }
  if (created.status !== 409) {
    throw new Error(`creating "${event.id}" answered ${created.status}: ${await created.text()}`);
  }

  const updated = await fetch(`${TICKET_URL}/admin/events/${event.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(details),
  });
  if (!updated.ok) {
    throw new Error(`updating "${event.id}" answered ${updated.status}: ${await updated.text()}`);
  }
  return `updated  ${event.id}  (times moved; stock left as it was)`;
}

async function main(): Promise<void> {
  const headers = {
    "content-type": "application/json",
    authorization: await bearer("admin", "admin"),
  };
  for (const event of SEEDS) {
    console.log(await seed(event, headers));
  }
  console.log("");
  console.log("Open http://localhost:8080 to see them.");
  console.log("The listing may take a couple of seconds to show an edit; queue-svc caches for 5.");
}

main().catch((error) => {
  console.error(
    `seed failed against ${TICKET_URL}: ${error instanceof Error ? error.message : error}`,
  );
  console.error("Is the ticket service running (`make dev`), with DATABASE_URL and REDIS_URL set?");
  process.exit(1);
});
