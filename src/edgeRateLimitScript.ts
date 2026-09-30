// Trim, compare, and admit in one Redis execution. Pipelines can interleave
// with other callers, including between ZCARD and ZADD.
export const EDGE_RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestMs = tonumber(oldest[2]) or now
if count >= limit then
  return {0, count, oldestMs}
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return {1, count + 1, oldestMs}
`;
