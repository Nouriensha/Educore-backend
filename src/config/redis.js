const Redis = require('ioredis');
const env = require('./env');

const normalizeNumberResult = (value) => {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
};

const executeUpstashCommand = async (command) => {
  const response = await fetch(env.redis.upstashRestUrl.replace(/\/$/, ''), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.redis.upstashRestToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(command)
  });

  const responseText = await response.text();
  let body = {};

  try {
    body = responseText ? JSON.parse(responseText) : {};
  } catch (_error) {
    body = {
      error: responseText
    };
  }

  if (!response.ok || body.error) {
    throw new Error(body.error || body.message || 'Upstash Redis command failed');
  }

  return body.result;
};

const createUpstashRestClient = () => ({
  get: (key) => executeUpstashCommand(['GET', key]),
  set: (key, value, expiryMode, expirySeconds, condition) => {
    const command = ['SET', key, value];

    if (expiryMode && expirySeconds) {
      command.push(expiryMode, expirySeconds);
    }

    if (condition) {
      command.push(condition);
    }

    return executeUpstashCommand(command);
  },
  del: (key) => executeUpstashCommand(['DEL', key]),
  incr: (key) => executeUpstashCommand(['INCR', key]),
  expire: (key, seconds) => executeUpstashCommand(['EXPIRE', key, seconds]),
  ttl: (key) => executeUpstashCommand(['TTL', key]),
  ping: () => executeUpstashCommand(['PING']),
  quit: async () => undefined
});

const createMemoryClient = () => {
  const store = new Map();

  const prune = (key) => {
    const entry = store.get(key);

    if (entry?.expiresAt && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }

    return entry || null;
  };

  return {
    get: async (key) => prune(key)?.value || null,
    set: async (key, value, expiryMode, expirySeconds, condition) => {
      if (condition === 'NX' && prune(key)) {
        return null;
      }

      const expiresAt = expiryMode === 'EX' && expirySeconds
        ? Date.now() + normalizeNumberResult(expirySeconds) * 1000
        : null;

      store.set(key, {
        value,
        expiresAt
      });

      return 'OK';
    },
    del: async (key) => (store.delete(key) ? 1 : 0),
    incr: async (key) => {
      const entry = prune(key);
      const nextValue = entry ? normalizeNumberResult(entry.value) + 1 : 1;

      store.set(key, {
        value: String(nextValue),
        expiresAt: entry?.expiresAt || null
      });

      return nextValue;
    },
    expire: async (key, seconds) => {
      const entry = prune(key);

      if (!entry) {
        return 0;
      }

      entry.expiresAt = Date.now() + normalizeNumberResult(seconds) * 1000;
      store.set(key, entry);
      return 1;
    },
    ttl: async (key) => {
      const entry = prune(key);

      if (!entry) {
        return -2;
      }

      if (!entry.expiresAt) {
        return -1;
      }

      return Math.max(Math.ceil((entry.expiresAt - Date.now()) / 1000), 0);
    },
    ping: async () => 'PONG',
    quit: async () => undefined
  };
};

const createDevelopmentFallbackClient = (primary, label) => {
  if (env.isProduction) {
    return primary;
  }

  const fallback = createMemoryClient();
  let warned = false;

  const run = async (method, args) => {
    try {
      return await primary[method](...args);
    } catch (error) {
      if (!warned) {
        warned = true;
        const reason = error.cause?.code || error.code || error.message;
        console.warn(`${label} unavailable (${reason}). Falling back to in-memory Redis for this process.`);
      }

      return fallback[method](...args);
    }
  };

  return {
    get: (...args) => run('get', args),
    set: (...args) => run('set', args),
    del: (...args) => run('del', args),
    incr: (...args) => run('incr', args),
    expire: (...args) => run('expire', args),
    ttl: (...args) => run('ttl', args),
    ping: (...args) => run('ping', args),
    quit: async () => {
      await primary.quit();
      await fallback.quit();
    }
  };
};

const createRedisClient = () => {
  if (process.env.NODE_ENV === 'test' || env.redis.useMemory) {
    return createMemoryClient();
  }

  if (env.redis.useUpstashRest) {
    return createDevelopmentFallbackClient(createUpstashRestClient(), 'Upstash Redis');
  }

  const redis = new Redis(env.redis.url, {
    enableReadyCheck: true,
    maxRetriesPerRequest: 3
  });

  redis.on('error', (error) => {
    if (!env.isProduction) {
      console.error('Redis error:', error.message);
    }
  });

  return createDevelopmentFallbackClient(redis, 'Redis');
};

const redis = createRedisClient();

module.exports = redis;
