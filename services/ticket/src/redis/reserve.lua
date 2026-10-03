-- services/ticket/src/redis/reserve.lua
-- KEYS: [ev:<eventId>:avail, ev:<eventId>:holds, ev:<eventId>:stream]
--       Plain, untagged key names. On a standalone Redis or a Sentinel primary/replica set there is
--       one keyspace and no slots, so this is fine. Redis CLUSTER would reject it: a script may only
--       touch keys in a single slot, and these three hash to different ones (CROSSSLOT). Going to
--       Cluster means restoring a shared hash tag -- ev:{<eventId>}:avail -- in reserveKeys() in
--       index.ts, in infra/redis/init.sh, and here.
-- ARGV: [eventId, userId, qty, ttl, now]   ttl and now are milliseconds.
--
-- Reply: {1, holdId} on success, {0, 'SOLD_OUT'} when there is not enough inventory left.
--
-- The flat array is deliberate. Redis turns a Lua table into a status reply only when its `ok` field
-- holds a STRING, and otherwise builds the reply from consecutive integer keys 1..n, stopping at the
-- first nil. So `{ok = true, holdId = x}` matches neither rule -- `ok` is a boolean, and there is no
-- [1] -- and converts to an empty array, leaving the caller unable to tell success from sold out or
-- to recover the holdId. Integers and strings in an array convert cleanly, so that is what we return.

local avail_key = KEYS[1]
local holds_key = KEYS[2]
local stream_key = KEYS[3]

local eventId = ARGV[1]
local userId = ARGV[2]
local qty = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local now = tonumber(ARGV[5])

-- 1. Check availability
local avail = tonumber(redis.call('GET', avail_key) or 0)
if avail < qty then
  return {0, 'SOLD_OUT'}
end

-- 2. Decrement available (atomic)
redis.call('DECRBY', avail_key, qty)

-- 3. Add to holds (ZSET with expiry timestamp as score)
local holdId = eventId .. ':' .. userId .. ':' .. now
redis.call('ZADD', holds_key, now + ttl, holdId)

-- 4. Append to stream for durability (Relay will read and produce to Kafka)
redis.call('XADD', stream_key, '*',
  'holdId', holdId,
  'userId', userId,
  'qty', qty,
  'timestamp', now
)

return {1, holdId}