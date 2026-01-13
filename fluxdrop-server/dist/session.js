// fluxdrop-server/src/session.ts
import { WebSocket } from 'ws';
export class SessionManager {
    sessions = new Map();
    SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    generateCode() {
        // Generate 6-digit code
        let code;
        let attempts = 0;
        do {
            code = Math.floor(100000 + Math.random() * 900000).toString();
            attempts++;
            if (attempts > 100) {
                // Fallback: cleanup old sessions and try again
                this.cleanupExpired();
                code = Math.floor(100000 + Math.random() * 900000).toString();
                break;
            }
        } while (this.sessions.has(code));
        return code;
    }
    createSession(code, senderWs) {
        const now = new Date();
        const session = {
            code,
            sender: senderWs,
            createdAt: now,
            expiresAt: new Date(now.getTime() + this.SESSION_TIMEOUT)
        };
        this.sessions.set(code, session);
        return session;
    }
    getSession(code) {
        const session = this.sessions.get(code);
        // Check if expired
        if (session && new Date() > session.expiresAt) {
            this.sessions.delete(code);
            return undefined;
        }
        return session;
    }
    addReceiver(code, receiverWs) {
        const session = this.getSession(code);
        if (!session)
            return false;
        session.receiver = receiverWs;
        return true;
    }
    removeClient(code, role) {
        const session = this.sessions.get(code);
        if (!session)
            return;
        if (role === 'sender') {
            // If sender leaves, delete entire session
            this.sessions.delete(code);
        }
        else if (role === 'receiver') {
            // If receiver leaves, just remove them
            delete session.receiver;
        }
    }
    cleanupExpired() {
        const now = new Date();
        let cleaned = 0;
        for (const [code, session] of this.sessions.entries()) {
            if (now > session.expiresAt) {
                this.sessions.delete(code);
                cleaned++;
            }
        }
        return cleaned;
    }
    getActiveSessionCount() {
        this.cleanupExpired();
        return this.sessions.size;
    }
}
//# sourceMappingURL=session.js.map