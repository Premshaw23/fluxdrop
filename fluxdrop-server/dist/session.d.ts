import { WebSocket } from 'ws';
interface Session {
    code: string;
    sender: WebSocket;
    receiver?: WebSocket;
    createdAt: number;
    expiresAt: number;
}
export declare class SessionManager {
    private sessions;
    private readonly SESSION_TIMEOUT;
    private readonly reservedPrefix;
    private readonly sessionPrefix;
    private redis;
    constructor();
    generateCode(): Promise<string>;
    createSession(code: string, sender: WebSocket): Promise<Session>;
    getSession(code: string): Session | undefined;
    addReceiver(code: string, receiver: WebSocket): Promise<boolean>;
    removeClient(code: string, role: 'sender' | 'receiver'): Promise<void>;
    cleanupExpired(): Promise<number>;
    getActiveSessionCount(): Promise<number>;
    private forceDelete;
    shutdown(): Promise<void>;
}
export {};
//# sourceMappingURL=session.d.ts.map