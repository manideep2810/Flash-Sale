-- KEYS[1] queue, KEYS[2] admitted, KEYS[3] state; ARGV[1] userId, ARGV[2] admitTtlMs
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local adm = redis.call('HGET', KEYS[2], ARGV[1])
if adm then
  if now - tonumber(adm) <= tonumber(ARGV[2]) then return {'ADMITTED', adm} end
  return {'EXPIRED'}
end
local state = redis.call('GET', KEYS[3]) or 'OPEN'
if state == 'SOLD_OUT' then return {'SOLD_OUT'} end
local rank = redis.call('ZRANK', KEYS[1], ARGV[1])
if rank then return {'QUEUED', rank, state} end
return {'NOT_IN_QUEUE'}
