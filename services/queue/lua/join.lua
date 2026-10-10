-- KEYS[1] queue zset, KEYS[2] admitted hash, KEYS[3] state
-- ARGV[1] userId, ARGV[2] saleOpensAtMs, ARGV[3] lotteryScore in [0,1) (crypto random from the server), ARGV[4] admitTtlMs
if redis.call('GET', KEYS[3]) == 'SOLD_OUT' then return {'SOLD_OUT'} end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local adm = redis.call('HGET', KEYS[2], ARGV[1])
if adm then
  if now - tonumber(adm) <= tonumber(ARGV[4]) then return {'ADMITTED'} end
  redis.call('HDEL', KEYS[2], ARGV[1])   -- turn expired: rejoin at the back
end
local score = now
if now < tonumber(ARGV[2]) then score = tonumber(ARGV[3]) end  -- lobby lottery
redis.call('ZADD', KEYS[1], 'NX', score, ARGV[1])   -- NX: refresh keeps your place
return {'QUEUED', redis.call('ZRANK', KEYS[1], ARGV[1])}
