-- Baseline concurrency experiments for the ticket service. Apply with `make baseline-db`.
-- Lives in its own schema so it never collides with the Prisma-managed `ticket` schema.
-- Idempotent: safe to re-run.

CREATE SCHEMA IF NOT EXISTS baseline;

CREATE TABLE IF NOT EXISTS baseline.inventory (
  event_id   text        PRIMARY KEY,
  total      integer     NOT NULL CHECK (total >= 0),
  -- Deliberately NO `available >= 0` check: the whole point of the baseline is to see which
  -- application strategies oversell. A DB constraint would mask the naive variant's bug as 500s.
  available  integer     NOT NULL,
  -- Bumped on every successful decrement; only the optimistic variant reads it.
  version    integer     NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS baseline.holds (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   text        NOT NULL REFERENCES baseline.inventory (event_id) ON DELETE CASCADE,
  user_id    text        NOT NULL,
  qty        integer     NOT NULL CHECK (qty > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS holds_event_id_idx ON baseline.holds (event_id);

-- Databases created by an earlier revision of this file carried the check; drop it if present.
ALTER TABLE baseline.inventory DROP CONSTRAINT IF EXISTS inventory_available_check;
