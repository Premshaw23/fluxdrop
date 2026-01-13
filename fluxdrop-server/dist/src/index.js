// fluxdrop-server/src/index.ts
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
import { SessionManager } from './session.js';
import { validateMessage } from "./types/message.js";
dotenv.config();
const PORT = parseInt(process.env.PORT || '3001');
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'];
// Create HTTP server for health checks
const server = createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            sessions: sessionManager.getActiveSessionCount(),
            timestamp: new Date().toISOString()
        }));
    }
    else {
        res.writeHead(404);
        res.end();
    }
});
// Create WebSocket server
const wss = new WebSocketServer({ server });
const sessionManager = new SessionManager();
const clients = new Map();
wss.on('connection', (ws, req) => {
    // Check origin
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        console.log(`❌ Rejected connection from ${origin}`);
        ws.close(1008, 'Origin not allowed');
        return;
    }
    const clientId = crypto.randomUUID();
    clients.set(ws, { ws, id: clientId });
    console.log(`✅ Client connected: ${clientId}`);
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            const validation = validateMessage(message);
            if (!validation.success) {
                sendError(ws, 'Invalid message format');
                return;
            }
            await handleMessage(ws, message);
        }
        catch (error) {
            console.error('Message handling error:', error);
            sendError(ws, 'Failed to process message');
        }
    });
    ws.on('close', async () => {
        const client = clients.get(ws);
        if (client?.sessionCode && client.role) {
            const session = sessionManager.getSession(client.sessionCode);
            // Remove from session manager first
            await sessionManager.removeClient(client.sessionCode, client.role);
            // Then notify and close the other peer if exists
            if (session) {
                const otherRole = client.role === 'sender' ? 'receiver' : 'sender';
                const otherClient = session[otherRole];
                if (otherClient && otherClient.readyState === WebSocket.OPEN) {
                    send(otherClient, { type: 'peer-disconnected' });
                    // If sender disconnected, close receiver too
                    if (client.role === 'sender') {
                        otherClient.close(1000, 'Sender disconnected');
                    }
                }
            }
        }
        clients.delete(ws);
        console.log(`👋 Client disconnected: ${client?.id}`);
    });
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});
async function handleMessage(ws, message) {
    const client = clients.get(ws);
    if (!client)
        return;
    switch (message.type) {
        case 'create-session':
            await handleCreateSession(ws, client);
            break;
        case 'join-session':
            await handleJoinSession(ws, client, message.code);
            break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
        case 'public-key':
            await handleSignaling(ws, client, message);
            break;
        default:
            sendError(ws, 'Unknown message type');
    }
}
async function handleCreateSession(ws, client) {
    const code = await sessionManager.generateCode();
    const session = await sessionManager.createSession(code, ws); // ADD await
    client.sessionCode = code;
    client.role = 'sender';
    send(ws, {
        type: 'session-created',
        code,
        expiresIn: 300 // 5 minutes
    });
    console.log(`📝 Session created: ${code}`);
}
async function handleJoinSession(ws, client, code) {
    const session = sessionManager.getSession(code);
    if (!session) {
        sendError(ws, 'Session not found or expired');
        return;
    }
    if (session.receiver) {
        sendError(ws, 'Session already has a receiver');
        return;
    }
    const added = await sessionManager.addReceiver(code, ws); // ADD await and check result
    if (!added) {
        sendError(ws, 'Failed to join session');
        return;
    }
    client.sessionCode = code;
    client.role = 'receiver';
    // Notify both parties
    send(ws, { type: 'session-joined', code });
    send(session.sender, { type: 'peer-joined' });
    console.log(`🤝 Receiver joined session: ${code}`);
}
async function handleSignaling(ws, client, message) {
    if (!client.sessionCode || !client.role) {
        sendError(ws, 'Not in a session');
        return;
    }
    const session = sessionManager.getSession(client.sessionCode);
    if (!session) {
        sendError(ws, 'Session not found');
        return;
    }
    // Forward to the other peer
    const targetRole = client.role === 'sender' ? 'receiver' : 'sender';
    const targetClient = session[targetRole];
    if (!targetClient) {
        sendError(ws, 'Peer not connected');
        return;
    }
    send(targetClient, message);
}
function send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}
function sendError(ws, error) {
    send(ws, { type: 'error', error });
}
// Cleanup expired sessions every minute
setInterval(async () => {
    const cleaned = await sessionManager.cleanupExpired(); // Move await here
    if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} expired sessions`);
    }
}, 60000);
// Graceful shutdown handlers
process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    // Close all WebSocket connections
    for (const [ws, client] of clients.entries()) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'Server shutting down');
        }
    }
    // Shutdown session manager (closes Redis)
    await sessionManager.shutdown();
    // Close WebSocket server
    wss.close(() => {
        console.log('✅ WebSocket server closed');
    });
    // Close HTTP server
    server.close(() => {
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
    // Force exit after 10 seconds
    setTimeout(() => {
        console.error('⚠️ Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
});
process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT received, shutting down gracefully...');
    process.emit('SIGTERM');
});
server.listen(PORT, () => {
    console.log(`🚀 FluxDrop Signaling Server running on port ${PORT}`);
    console.log(`📡 WebSocket ready at ws://localhost:${PORT}`);
    console.log(`💚 Health check at http://localhost:${PORT}/health`);
});
//# sourceMappingURL=index.js.map