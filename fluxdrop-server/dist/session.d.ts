import { WebSocket } from 'ws';
interface Session {
    code: string;
    sender: WebSocket;
    receiver?: WebSocket;
    createdAt: Date;
    expiresAt: Date;
}
export declare class SessionManager {
    private sessions;
    private readonly SESSION_TIMEOUT;
    generateCode(): string;
    createSession(code: string, senderWs: WebSocket): Session;
    getSession(code: string): Session | undefined;
    addReceiver(code: string, receiverWs: WebSocket): boolean;
    removeClient(code: string, role: 'sender' | 'receiver'): void;
    cleanupExpired(): number;
    getActiveSessionCount(): number;
}
export {};
//# sourceMappingURL=session.d.ts.map