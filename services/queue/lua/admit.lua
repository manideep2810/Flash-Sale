-- KEYS[1] queue, KEYS[2] admitted, KEYS[3] state, KEYS[4] avail (Phase 2), KEYS[5] holds (Phase 2)
-- ARGV[1] n
local avail = tonumber(redis.call('GET', KEYS[4]) or '0')
if avail <= 0 then
  if redis.call('ZCARD', KEYS[5]) == 0 then
    redis.call('SET', KEYS[3], 'SOLD_OUT'); return {-1}   -- nothing left, nothing held
  end
  redis.call('SET', KEYS[3], 'PAUSED'); return {0}        -- holds may still expire
end
redis.call('SET', KEYS[3], 'OPEN')
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local popped = redis.call('ZPOPMIN', KEYS[1], ARGV[1])   -- {member, score, member, score, ...}
for i = 1, #popped, 2 do redis.call('HSET', KEYS[2], popped[i], now) end
return {#popped / 2}
