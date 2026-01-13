// fluxdrop-server/src/session.ts
import { WebSocket } from 'ws';
import Redis, { Redis as RedisType } from 'ioredis';
export class SessionManager {
    sessions = new Map();
    SESSION_TIMEOUT = 5 * 60 * 1000; // 5 min
    reservedPrefix = 'reserved:'; // For code reservation (STRING)
    sessionPrefix = 'session:'; // For session data (HASH)
    redis;
    constructor() {
        if (!process.env.REDIS_URL) {
            throw new Error('REDIS_URL is not defined');
        }
        this.redis = new Redis(process.env.REDIS_URL);
        // Handle Redis connection errors
        this.redis.on('error', (err) => {
            console.error('Redis connection error:', err);
        });
    }
    async generateCode() {
        const ttl = Math.floor(this.SESSION_TIMEOUT / 1000);
        for (let i = 0; i < 100; i++) {
            const code = Math.floor(100000 + Math.random() * 900000).toString();
            try {
                // Use reservedPrefix for code reservation (STRING)
                const wasSet = await this.redis.setnx(this.reservedPrefix + code, 'reserved');
                if (wasSet === 1) {
                    await this.redis.expire(this.reservedPrefix + code, ttl);
                    return code;
                }
            }
            catch (error) {
                console.error('Redis error during code generation:', error);
                throw new Error('Failed to generate session code due to Redis error');
            }
        }
        throw new Error('Unable to generate unique session code');
    }
    async createSession(code, sender) {
        const now = Date.now();
        const ttl = Math.floor(this.SESSION_TIMEOUT / 1000);
        const session = {
            code,
            sender,
            createdAt: now,
            expiresAt: now + this.SESSION_TIMEOUT
        };
        this.sessions.set(code, session);
        try {
            // Use sessionPrefix for session data (HASH)
            await this.redis.hset(this.sessionPrefix + code, {
                createdAt: now.toString(),
                expiresAt: session.expiresAt.toString(),
                hasReceiver: 'false'
            });
            await this.redis.expire(this.sessionPrefix + code, ttl);
        }
        catch (error) {
            console.error('Redis error during session creation:', error);
            this.sessions.delete(code);
            throw new Error('Failed to create session');
        }
        return session;
    }
    getSession(code) {
        const session = this.sessions.get(code);
        if (!session)
            return undefined;
        if (Date.now() > session.expiresAt) {
            this.forceDelete(code).catch(err => {
                console.error('Error force deleting expired session:', err);
            });
            return undefined;
        }
        return session;
    }
    async addReceiver(code, receiver) {
        const session = this.getSession(code);
        if (!session || session.receiver)
            return false;
        session.receiver = receiver;
        try {
            await this.redis.hset(this.sessionPrefix + code, 'hasReceiver', 'true');
        }
        catch (error) {
            console.error('Redis error during receiver addition:', error);
        }
        return true;
    }
    async removeClient(code, role) {
        const session = this.sessions.get(code);
        if (!session)
            return;
        if (role === 'sender') {
            await this.forceDelete(code);
        }
        else {
            delete session.receiver;
            try {
                await this.redis.hset(this.sessionPrefix + code, 'hasReceiver', 'false');
            }
            catch (error) {
                console.error('Redis error during receiver removal:', error);
            }
        }
    }
    async cleanupExpired() {
        const now = Date.now();
        const expired = [];
        for (const [code, session] of this.sessions.entries()) {
            if (now > session.expiresAt) {
                expired.push(code);
                if (session.sender.readyState === WebSocket.OPEN) {
                    session.sender.close(1000, 'Session expired');
                }
                if (session.receiver && session.receiver.readyState === WebSocket.OPEN) {
                    session.receiver.close(1000, 'Session expired');
                }
                this.sessions.delete(code);
            }
        }
        if (expired.length > 0) {
            try {
                // Delete both reserved and session keys
                const keys = expired.flatMap(c => [
                    this.reservedPrefix + c,
                    this.sessionPrefix + c
                ]);
                await this.redis.del(...keys);
            }
            catch (error) {
                console.error('Redis error during cleanup:', error);
            }
        }
        return expired.length;
    }
    async getActiveSessionCount() {
        await this.cleanupExpired();
        return this.sessions.size;
    }
    async forceDelete(code) {
        this.sessions.delete(code);
        try {
            // Delete both reserved and session keys
            await this.redis.del(this.reservedPrefix + code, this.sessionPrefix + code);
        }
        catch (error) {
            console.error('Redis error during force delete:', error);
        }
    }
    async shutdown() {
        // Close all active WebSocket connections
        for (const [code, session] of this.sessions.entries()) {
            if (session.sender.readyState === WebSocket.OPEN) {
                session.sender.close(1000, 'Server shutting down');
            }
            if (session.receiver && session.receiver.readyState === WebSocket.OPEN) {
                session.receiver.close(1000, 'Server shutting down');
            }
        }
        this.sessions.clear();
        try {
            await this.redis.quit();
        }
        catch (error) {
            console.error('Error during Redis shutdown:', error);
        }
    }
}
//# sourceMappingURL=session.js.map