// fluxdrop-web/lib/signaling/SignalingClient.ts

type MessageHandler = (message: any) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private messageHandlers = new Map<string, MessageHandler>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  public onOpen?: () => void;
  public onClose?: () => void;
  public onError?: (error: Event) => void;

  constructor(private url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log('🔗 Connected to signaling server');
          this.reconnectAttempts = 0;
          this.onOpen?.();
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            console.error('Failed to parse message:', error);
          }
        };

        this.ws.onerror = (error) => {
          console.error('❌ WebSocket error:', error);
          this.onError?.(error);
          reject(error);
        };

        this.ws.onclose = () => {
          console.log('🔌 Disconnected from signaling server');
          this.onClose?.();
          this.attemptReconnect();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch(console.error);
    }, delay);
  }

  private handleMessage(message: any) {
    console.log('📨 Received:', message.type);

    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      handler(message);
    } else {
      console.warn('No handler for message type:', message.type);
    }
  }

  on(type: string, handler: MessageHandler) {
    this.messageHandlers.set(type, handler);
  }

  off(type: string) {
    this.messageHandlers.delete(type);
  }

  send(message: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('❌ Cannot send: WebSocket not connected');
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      console.log('📤 Sent:', message.type);
      return true;
    } catch (error) {
      console.error('Failed to send message:', error);
      return false;
    }
  }

  createSession(senderName?: string) {
    this.send({ type: 'create-session', senderName });
  }

  joinSession(code: string) {
    this.send({ type: 'join-session', code });
  }


  sendOffer(sdp: string) {
    this.send({ type: 'offer', sdp });
  }

  sendAnswer(sdp: string) {
    this.send({ type: 'answer', sdp });
  }

  sendIceCandidate(candidate: RTCIceCandidate) {
    this.send({
      type: 'ice-candidate',
      candidate: {
        candidate: candidate.candidate,
        sdpMLineIndex: candidate.sdpMLineIndex,
        sdpMid: candidate.sdpMid
      }
    });
  }

  /**
   * Send ECDH public key (Uint8Array or base64 string)
   */
  sendPublicKey(publicKey: string) {
    this.send({ type: 'public-key', publicKey });
  }

  // 🔍 Discovery Methods

  announceDevice(device: any) {
    this.send({
      type: 'discovery:announce',
      device
    });
  }

  discoverDevices() {
    this.send({ type: 'discovery:list' });
  }

  inviteDevice(targetId: string, code: string, senderName: string) {
    this.send({
      type: 'discovery:invite',
      targetId,
      code,
      senderName
    });
  }

  disconnect() {
    if (this.ws) {
      // Clear handlers to prevent reconnect/logging
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;

      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.messageHandlers.clear();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}