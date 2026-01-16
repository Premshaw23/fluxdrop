// fluxdrop-server/src/index.ts
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
import { SessionManager } from './session.js';
import { DiscoveryService } from './discovery.js';
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
const discoveryService = new DiscoveryService();
const clients = new Map();
wss.on('connection', (ws, req) => {
    // Check origin
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        console.log(`❌ Rejected connection from ${origin}`);
        ws.close(1008, 'Origin not allowed');
        return;
    }
    // Get IP address for discovery grouping
    // Get IP address for discovery grouping
    const forwardedFor = req.headers['x-forwarded-for'];
    // Handle array or string headers securely
    const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(',')[0];
    const ip = forwardedIp?.trim() ||
        req.socket.remoteAddress ||
        'unknown';
    const clientId = crypto.randomUUID();
    clients.set(ws, { ws, id: clientId, ip });
    console.log(`✅ Client connected: ${clientId} (IP: ${ip})`);
    // Debug headers if IP is unknown
    if (ip === 'unknown' || ip === '::1') {
        console.log('🔍 Headers:', JSON.stringify(req.headers));
    }
    ws.on('message', async (data) => {
        try {
            const rawMessage = JSON.parse(data.toString());
            // DEBUG LOG
            console.log('📨 Server received:', rawMessage.type);
            // 🟢 DISCOVERY PROTOCOL (Strictly separated)
            if (rawMessage.type && rawMessage.type.startsWith('discovery:')) {
                try {
                    await handleDiscoveryMessage(ws, rawMessage, ip, clientId);
                }
                catch (err) {
                    console.error('Discovery error:', err);
                    sendError(ws, `Discovery failed: ${err.message}`);
                }
                return;
            }
            // 🔵 SIGNALING PROTOCOL
            const message = rawMessage;
            const validation = validateMessage(message);
            if (!validation.success) {
                console.warn(`⚠️ Invalid message format from ${clientId}:`, validation.error);
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
        if (client) {
            // 1. Cleanup Sessions
            if (client.sessionCode && client.role) {
                const session = sessionManager.getSession(client.sessionCode);
                await sessionManager.removeClient(client.sessionCode, client.role);
                if (session) {
                    const otherRole = client.role === 'sender' ? 'receiver' : 'sender';
                    const otherClient = session[otherRole];
                    if (otherClient && otherClient.readyState === WebSocket.OPEN) {
                        send(otherClient, { type: 'peer-disconnected' });
                        if (client.role === 'sender') {
                            otherClient.close(1000, 'Sender disconnected');
                        }
                    }
                }
            }
            // 2. Cleanup Discovery
            const idToRemove = client.deviceId || client.id;
            // Check if there are other connections for the same deviceId
            // to avoid removing it if the user just closed one of multiple tabs.
            let isDeviceStillConnected = false;
            if (client.deviceId) {
                for (const [otherWs, otherClient] of clients.entries()) {
                    if (otherWs !== ws && otherClient.deviceId === client.deviceId) {
                        isDeviceStillConnected = true;
                        break;
                    }
                }
            }
            if (!isDeviceStillConnected) {
                await discoveryService.removeDevice(client.ip, idToRemove);
                console.log(`📡 Device removed from discovery: ${idToRemove}`);
            }
            clients.delete(ws);
            console.log(`👋 Client disconnected: ${client.id} (Device: ${client.deviceId || 'none'})`);
        }
    });
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});
async function handleDiscoveryMessage(ws, message, ip, clientId) {
    switch (message.type) {
        case 'discovery:announce':
            // Client is announcing its presence
            if (message.device) {
                const client = clients.get(ws);
                if (!client)
                    return;
                // Use client-provided ID for deduplication if available, otherwise fallback to connection ID
                const finalId = message.device.id || clientId;
                client.deviceId = finalId; // Track which device ID this connection is associated with
                const device = { ...message.device, id: finalId };
                await discoveryService.announceDevice(ip, device);
                // Acknowledge
                send(ws, { type: 'discovery:announced', device });
            }
            break;
        case 'discovery:list':
            // Client wants to know who is nearby
            const devices = await discoveryService.getPeers(ip);
            const clientObj = clients.get(ws);
            // Filter out self using the persistent device ID if known, otherwise connection ID
            const myId = clientObj?.deviceId || clientId;
            const others = devices.filter(d => d.id !== myId);
            send(ws, { type: 'discovery:peers', peers: others });
            break;
        case 'discovery:invite':
            // Sender wants to invite a specific device to a session
            if (message.targetId && message.code) {
                // Find the target client connection
                // We need to look up by ID. Our `clients` map is Map<WebSocket, ClientConnection>.
                // This is O(N) unless we keep a secondary index. For now O(N) is fine for small scale.
                let targetWs;
                for (const [s, c] of clients.entries()) {
                    // Check both deviceId AND connection id for compatibility
                    if (c.deviceId === message.targetId || c.id === message.targetId) {
                        targetWs = s;
                        break;
                    }
                }
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    send(targetWs, {
                        type: 'discovery:invite',
                        code: message.code,
                        senderName: message.senderName || 'Someone'
                    });
                }
            }
            break;
        default:
            // Ignore unknown discovery messages safely
            break;
    }
}
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
        case 'session-cancel':
            await handleSessionCancel(ws, client);
            break;
        default:
            sendError(ws, 'Unknown message type');
    }
}
async function handleCreateSession(ws, client) {
    const code = await sessionManager.generateCode();
    const session = await sessionManager.createSession(code, ws);
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
    const added = await sessionManager.addReceiver(code, ws);
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
async function handleSessionCancel(ws, client) {
    if (!client.sessionCode || !client.role)
        return;
    const session = sessionManager.getSession(client.sessionCode);
    if (!session)
        return;
    console.log(`❌ Session cancelled by ${client.role}: ${client.sessionCode}`);
    // Notify other peer
    const otherRole = client.role === 'sender' ? 'receiver' : 'sender';
    const otherClient = session[otherRole];
    if (otherClient && otherClient.readyState === WebSocket.OPEN) {
        send(otherClient, { type: 'peer-disconnected' });
    }
    // Remove the session
    await sessionManager.removeClient(client.sessionCode, client.role);
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
    const cleaned = await sessionManager.cleanupExpired();
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
    // Shutdown managers
    await sessionManager.shutdown();
    await discoveryService.shutdown();
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