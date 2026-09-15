const { createRedisRateLimiter } = require('../../../src/middlewares/rateLimiter.middleware');
const redis = require('../../../src/config/redis');
const { ApiError } = require('../../../src/utils/errors');

describe('RateLimiter Middleware Unit Tests', () => {
  let req, res, next;

  beforeEach(async () => {
    if (typeof redis.flushall === 'function') {
      await redis.flushall();
    }
    req = {
      method: 'GET',
      baseUrl: '/api/v1',
      path: '/test',
      ip: '127.0.0.1'
    };
    res = {
      set: jest.fn()
    };
    next = jest.fn();
  });

  test('should allow request under limit and set RateLimit response headers', async () => {
    const limiter = createRedisRateLimiter({
      prefix: 'test-limit',
      windowSeconds: 60,
      max: 5
    });

    await limiter(req, res, next);

    expect(res.set).toHaveBeenCalledWith('RateLimit-Limit', '5');
    expect(res.set).toHaveBeenCalledWith('RateLimit-Remaining', '4');
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  test('should pass 429 ApiError RATE_LIMITED when request count exceeds max limit', async () => {
    const limiter = createRedisRateLimiter({
      prefix: 'test-limit-exceed',
      windowSeconds: 60,
      max: 2
    });

    // Request 1
    await limiter(req, res, next);
    expect(next).toHaveBeenCalledWith();
    next.mockClear();

    // Request 2
    await limiter(req, res, next);
    expect(next).toHaveBeenCalledWith();
    next.mockClear();

    // Request 3 - Limit exceeded
    await limiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.details).toHaveProperty('retryAfterSeconds');
  });

  test('should return 503 RATE_LIMITER_UNAVAILABLE if Redis throws an unexpected connection error', async () => {
    const limiter = createRedisRateLimiter({
      prefix: 'test-redis-err',
      windowSeconds: 60,
      max: 5
    });

    const spy = jest.spyOn(redis, 'incr').mockRejectedValueOnce(new Error('Redis connection lost'));

    await limiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('RATE_LIMITER_UNAVAILABLE');

    spy.mockRestore();
  });
});
