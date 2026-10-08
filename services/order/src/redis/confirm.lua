-- services/order/src/redis/confirm.lua
-- KEYS: [ev:<eventId>:sold, ev:<eventId>:holds, ev:<eventId>:held]
-- ARGV: [holdId, qty]
--
-- Turns a hold into a sale, once: held -> sold (sold up and held down by the same quantity, in one
-- atomic step). It happens only when ZREM actually removed the hold, so a repeat changes nothing, and
-- avail is never touched (the tickets left it when they were held).
--
-- Reply: 1 when this call confirmed the hold, 0 when it was not there. For a PAID order, 0 means the
-- hold was already gone: either it was confirmed before (a repeat), or something removed it from
-- under a paid order, which is an oversell risk the caller must report.

if redis.call('ZREM', KEYS[2], ARGV[1]) == 1 then
  redis.call('INCRBY', KEYS[1], tonumber(ARGV[2]))
  redis.call('DECRBY', KEYS[3], tonumber(ARGV[2]))
  return 1
end
return 0
