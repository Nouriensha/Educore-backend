if (process.env.USE_CUSTOM_DNS === 'true') {
  const dns = require('node:dns');
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}

const app = require('./app');
const env = require('./config/env');
const logger = require('./utils/logger');
const redis = require('./config/redis');
const { connectMongo, mongoose } = require('./config/database');
const { recoverStrandedProcessingVideos } = require('./services/video.service');

let server;

const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const waitForRedis = async () => {
  const maxAttempts = env.redis.useMemory ? 1 : 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await redis.ping();
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }

      const retryDelayMs = 500 * attempt;
      const reason = error.cause?.code || error.code || error.message;
      logger.warn(`Redis ping failed (${reason}). Retrying in ${retryDelayMs}ms...`);
      await sleep(retryDelayMs);
    }
  }
};

const shutdown = async (signal) => {
  logger.info(`${signal} received. Shutting down gracefully.`);

  if (server) {
    server.close(async () => {
      await mongoose.connection.close(false);
      await redis.quit();
      process.exit(0);
    });
    return;
  }

  await mongoose.connection.close(false);
  await redis.quit();
  process.exit(0);
};

const start = async () => {
  await connectMongo();
  await waitForRedis();
  
  // Self-healing startup recovery routine for stranded processing videos
  recoverStrandedProcessingVideos().catch((err) => {
    logger.error('[VIDEO RECOVERY] Startup self-healing recovery failed', { error: err.message });
  });

  server = app.listen(env.port, () => {
    logger.info(`EduCore LMS API listening on port ${env.port}`, {
      environment: env.nodeEnv,
      port: env.port
    });
  });
};



process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection', { error: error?.message, stack: error?.stack });
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error?.message, stack: error?.stack });
  shutdown('uncaughtException');
});

start().catch((error) => {
  logger.error('Failed to start server', { error: error?.message });
  process.exit(1);
});
