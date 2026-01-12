// fluxdrop-server/src/index.ts
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import dotenv from 'dotenv';
import { SessionManager } from './session.js';
import { validateMessage,type SignalingMessage } from "./types/message.js"

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
  } else {
    res.writeHead(404);
    res.end();
  }
});

// Create WebSocket server
const wss = new WebSocketServer({ server });
const sessionManager = new SessionManager();

// Store client connections with metadata
interface ClientConnection {
  ws: WebSocket;
  sessionCode?: string;
  role?: 'sender' | 'receiver';
  id: string;
}

const clients = new Map<WebSocket, ClientConnection>();

wss.on('connection', (ws: WebSocket, req) => {
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

  ws.on('message', async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString()) as SignalingMessage;
      const validation = validateMessage(message);
      
      if (!validation.success) {
        sendError(ws, 'Invalid message format');
        return;
      }

      await handleMessage(ws, message);
    } catch (error) {
      console.error('Message handling error:', error);
      sendError(ws, 'Failed to process message');
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client?.sessionCode) {
      sessionManager.removeClient(client.sessionCode, client.role!);
      
      // Notify the other peer
      const session = sessionManager.getSession(client.sessionCode);
      if (session) {
        const otherRole = client.role === 'sender' ? 'receiver' : 'sender';
        const otherClient = session[otherRole];
        if (otherClient) {
          send(otherClient, { type: 'peer-disconnected' });
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

async function handleMessage(ws: WebSocket, message: SignalingMessage) {
  const client = clients.get(ws);
  if (!client) return;

  switch (message.type) {
    case 'create-session':
      await handleCreateSession(ws, client);
      break;
    
    case 'join-session':
      await handleJoinSession(ws, client, message.code!);
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

async function handleCreateSession(ws: WebSocket, client: ClientConnection) {
  const code = sessionManager.generateCode();
  const session = sessionManager.createSession(code, ws);
  
  client.sessionCode = code;
  client.role = 'sender';
  
  send(ws, {
    type: 'session-created',
    code,
    expiresIn: 300 // 5 minutes
  });
  
  console.log(`📝 Session created: ${code}`);
}

async function handleJoinSession(ws: WebSocket, client: ClientConnection, code: string) {
  const session = sessionManager.getSession(code);
  
  if (!session) {
    sendError(ws, 'Session not found or expired');
    return;
  }
  
  if (session.receiver) {
    sendError(ws, 'Session already has a receiver');
    return;
  }
  
  sessionManager.addReceiver(code, ws);
  client.sessionCode = code;
  client.role = 'receiver';
  
  // Notify both parties
  send(ws, { type: 'session-joined', code });
  send(session.sender, { type: 'peer-joined' });
  
  console.log(`🤝 Receiver joined session: ${code}`);
}

async function handleSignaling(ws: WebSocket, client: ClientConnection, message: SignalingMessage) {
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

function send(ws: WebSocket, message: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws: WebSocket, error: string) {
  send(ws, { type: 'error', error });
}

// Cleanup expired sessions every minute
setInterval(() => {
  const cleaned = sessionManager.cleanupExpired();
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} expired sessions`);
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`🚀 FluxDrop Signaling Server running on port ${PORT}`);
  console.log(`📡 WebSocket ready at ws://localhost:${PORT}`);
  console.log(`💚 Health check at http://localhost:${PORT}/health`);
});