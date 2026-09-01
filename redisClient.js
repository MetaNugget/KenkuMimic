const Redis = require('ioredis');

// Exported directly (not wrapped), same reasoning as the sibling bot: a thin
// get/set wrapper would just end up re-implementing ioredis's own API.
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

module.exports = redis;
