-- services/order/src/redis/release.lua
-- KEYS: [ev:<eventId>:avail, ev:<eventId>:holds, ev:<eventId>:held]
-- ARGV: [holdId, qty]
--
-- Returns the hold to inventory, once: avail up and held down by the same quantity, in one atomic step
-- (reserve.lua put them on hold). It happens only when ZREM actually removed the hold, so
-- running this again for the same hold (a redelivered event, a sweeper retry after a crash between
-- Redis and Postgres) changes nothing.
--
-- Reply: 1 when this call released the hold, 0 when it was already gone.

if redis.call('ZREM', KEYS[2], ARGV[1]) == 1 then
  redis.call('INCRBY', KEYS[1], tonumber(ARGV[2]))
  redis.call('DECRBY', KEYS[3], tonumber(ARGV[2]))
  return 1
end
return 0
