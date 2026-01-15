// fluxdrop-server/src/discovery.ts
import Redis, { Redis as RedisType } from 'ioredis';
export class DiscoveryService {
    redis;
    PREFIX = 'discovery:ip:';
    REFRESH_TTL = 30; // Seconds before device is removed
    constructor() {
        if (!process.env.REDIS_URL) {
            throw new Error('REDIS_URL is not defined in environment variables');
        }
        this.redis = new Redis(process.env.REDIS_URL);
    }
    /**
     * Announce a device's presence to its public IP group
     */
    async announceDevice(ip, device) {
        const key = this.PREFIX + ip;
        const value = JSON.stringify(device);
        // We store devices in a Set to handle multiple unique devices per IP
        // But since a Set doesn't handle TTL for individual items well without hacks,
        // we'll simpler: Use a Hash where field=deviceId, val=deviceInfo.
        // AND we set the expire on the whole key.
        // This means *active* IP groups stay alive. 
        // If one device leaves, it just stops heartbeating.
        // We rely on clients re-announcing every 10s to keep the IP key alive.
        await this.redis.hset(key, device.id, value);
        await this.redis.expire(key, this.REFRESH_TTL);
    }
    /**
     * Get all active devices on the same public IP
     */
    async getPeers(ip) {
        const key = this.PREFIX + ip;
        const data = await this.redis.hgetall(key);
        // Convert Hash {id: json} to Array of objects
        return Object.values(data).map(json => {
            try {
                return JSON.parse(json);
            }
            catch (e) {
                return null;
            }
        }).filter(Boolean);
    }
    /**
     * Explicitly remove a device (e.g. on disconnect)
     */
    async removeDevice(ip, deviceId) {
        const key = this.PREFIX + ip;
        await this.redis.hdel(key, deviceId);
    }
    async shutdown() {
        // Redis connection is shared or standalone? 
        // If standalone here, close it.
        // In this codebase, we create a new connection per service.
        // So we should close it.
        try {
            await this.redis.quit();
        }
        catch (error) {
            console.error('Error closing Redis in DiscoveryService:', error);
        }
    }
}
//# sourceMappingURL=discovery.js.map