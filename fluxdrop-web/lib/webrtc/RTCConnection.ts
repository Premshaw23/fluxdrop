// fluxdrop-web/lib/webrtc/RTCConnection.ts

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed';
export type DataChannelState = 'closed' | 'opening' | 'open';

interface RTCConnectionConfig {
  onStateChange?: (state: ConnectionState) => void;
  onDataChannelOpen?: () => void;
  onDataChannelClose?: () => void;
  onMessage?: (data: ArrayBuffer) => void;
  onError?: (error: Error) => void;
}

export class RTCConnection {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private config: RTCConnectionConfig;
  
  public onIceCandidate?: (candidate: RTCIceCandidate) => void;
  public onOffer?: (offer: RTCSessionDescriptionInit) => void;
  public onAnswer?: (answer: RTCSessionDescriptionInit) => void;

  constructor(config: RTCConnectionConfig = {}) {
    this.config = config;
  }

  
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectDelay = 2000;

  async initialize(role: 'sender' | 'receiver') {
    const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME || '';
    const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL || '';
    const configuration: RTCConfiguration = {
      iceServers: [
        {
          urls: 'stun:stun.relay.metered.ca:80',
        },
        {
          urls: 'turn:global.relay.metered.ca:80',
          username: turnUsername,
          credential: turnCredential,
        },
        {
          urls: 'turn:global.relay.metered.ca:80?transport=tcp',
          username: turnUsername,
          credential: turnCredential,
        },
        {
          urls: 'turn:global.relay.metered.ca:443',
          username: turnUsername,
          credential: turnCredential,
        },
        {
          urls: 'turns:global.relay.metered.ca:443?transport=tcp',
          username: turnUsername,
          credential: turnCredential,
        },
      ]
    };

    this.peerConnection = new RTCPeerConnection(configuration);

    // Handle ICE candidates
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        this.onIceCandidate(event.candidate);
      }
    };

    // Log connection type and quality
    this.peerConnection.oniceconnectionstatechange = () => {
      const iceState = this.peerConnection?.iceConnectionState;
      console.log('🧊 ICE state:', iceState);

      // Check for relay (TURN) or direct (P2P)
      const stats = this.peerConnection?.getStats ? this.peerConnection.getStats() : null;
      if (stats) {
        stats.then((report) => {
          report.forEach((stat) => {
            if (stat.type === 'candidate-pair' && stat.state === 'connected') {
              const local = report.get(stat.localCandidateId);
              const remote = report.get(stat.remoteCandidateId);
              if (local && remote) {
                const isRelay = local.candidateType === 'relay' || remote.candidateType === 'relay';
                console.log('🔎 Connection type:', isRelay ? 'TURN relay' : 'P2P direct');
                // Basic quality indicator
                if (typeof stat.currentRoundTripTime === 'number') {
                  const rtt = stat.currentRoundTripTime;
                  let quality = 'good';
                  if (rtt > 0.5) quality = 'poor';
                  else if (rtt > 0.2) quality = 'fair';
                  console.log('📈 Connection quality:', quality, `(RTT: ${rtt}s)`);
                }
              }
            }
          });
        });
      }

      // Detect connection drops and auto-reconnect
      if (iceState === 'disconnected' || iceState === 'failed') {
        console.warn('⚠️ Connection dropped. Attempting auto-reconnect...');
        this.attemptReconnect(role);
      }
    };

    // Ensure receiver attaches data channel listener
    if (role === 'receiver') {
      this.setupDataChannelListener();
    }
  }
  private async attemptReconnect(role: 'sender' | 'receiver') {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ Max reconnect attempts reached. Giving up.');
      this.config.onError?.(new Error('Max reconnect attempts reached'));
      return;
    }
    this.reconnectAttempts++;
    console.log(`🔄 Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
    // Close and re-initialize connection
    this.close();
    setTimeout(() => {
      this.initialize(role);
    }, this.reconnectDelay * this.reconnectAttempts);
  }

    // ...existing code...
  // No stray closing brace here

  public async createDataChannel() {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    console.log('[RTCConnection][DEBUG] Creating data channel (sender)...');
    this.dataChannel = this.peerConnection.createDataChannel('fileTransfer', {
      ordered: true,
      maxRetransmits: 3
    });
    if (this.dataChannel) {
      console.log('[RTCConnection][DEBUG] Data channel object:', this.dataChannel);
    } else {
      console.error('[RTCConnection][DEBUG] Data channel creation failed!');
    }
    this.setupDataChannelHandlers();
    console.log('📤 Data channel created (sender)');
  }

  private setupDataChannelListener() {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    this.peerConnection.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupDataChannelHandlers();
      console.log('📥 Data channel received (receiver)');
    };
  }

  private setupDataChannelHandlers() {
    if (!this.dataChannel) {
      console.error('[RTCConnection][DEBUG] setupDataChannelHandlers: dataChannel is null');
      return;
    }

    this.dataChannel.binaryType = 'arraybuffer';
    console.log('[RTCConnection][DEBUG] setupDataChannelHandlers: Handlers attached');

    this.dataChannel.onopen = () => {
      console.log('[RTCConnection][DEBUG] Data channel onopen event');
      console.log('✅ Data channel opened');
      this.config.onDataChannelOpen?.();
    };

    this.dataChannel.onclose = () => {
      console.log('[RTCConnection][DEBUG] Data channel onclose event');
      console.log('👋 Data channel closed');
      this.config.onDataChannelClose?.();
    };

    this.dataChannel.onmessage = (event) => {
      console.log('[RTCConnection][DEBUG] Data channel onmessage event');
      console.log('[RTCConnection] Data channel received message, bytes:', event.data?.byteLength);
      if (event.data instanceof ArrayBuffer) {
        this.config.onMessage?.(event.data);
      } else {
        console.warn('[RTCConnection] Received non-ArrayBuffer message:', event.data);
      }
    };

    this.dataChannel.onerror = (error) => {
      console.log('[RTCConnection][DEBUG] Data channel onerror event');
      // console.error('❌ Data channel error:', error);
      this.config.onError?.(new Error('Data channel error'));
    };
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    
    console.log('📝 Offer created');
    return offer;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    
    console.log('📝 Answer created');
    return answer;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(description));
    console.log('📥 Remote description set:', description.type);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('🧊 ICE candidate added');
    } catch (error) {
      console.error('Failed to add ICE candidate:', error);
    }
  }

  send(data: ArrayBuffer | Uint8Array): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      console.error('❌ Cannot send: Data channel not open');
      return false;
    }

    try {
      if (data instanceof ArrayBuffer) {
        // Send ArrayBuffer directly
        this.dataChannel.send(data);
        console.log('[RTCConnection] Sent ArrayBuffer, bytes:', data.byteLength);
      } else if (data instanceof Uint8Array) {
        // Handle TypedArray views correctly
        let bufferToSend: ArrayBuffer;
        if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength || !(data.buffer instanceof ArrayBuffer)) {
          // This is a view/slice or not an ArrayBuffer - copy to a new ArrayBuffer
          const copy = new Uint8Array(data.byteLength);
          copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          bufferToSend = copy.buffer;
        } else {
          bufferToSend = data.buffer as ArrayBuffer;
        }
        this.dataChannel.send(bufferToSend);
        console.log('[RTCConnection] Sent Uint8Array as ArrayBuffer, bytes:', data.byteLength);
      } else {
        const err = new Error('Unsupported data type for send');
        console.error('❌ Send failed:', err);
        this.config.onError?.(err);
        return false;
      }
      return true;
    } catch (error) {
      const errObj = error instanceof Error ? error : new Error('Send failed');
      console.error('❌ Send failed:', errObj);
      this.config.onError?.(errObj);
      return false;
    }
  }

  getConnectionState(): ConnectionState {
    return (this.peerConnection?.connectionState as ConnectionState) || 'disconnected';
  }

  getDataChannelState(): DataChannelState {
    if (!this.dataChannel) return 'closed';
    return this.dataChannel.readyState === 'open' ? 'open' : 
           this.dataChannel.readyState === 'connecting' ? 'opening' : 'closed';
  }

  getBufferedAmount(): number {
    return this.dataChannel?.bufferedAmount || 0;
  }

  close() {
    console.log('🔌 Closing connection...');
    
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }
    // Example integration for transfer state preservation
    // Usage: Call these methods on reconnect to save/restore transfer progress
    // sender.serializeState() to get current state
    // sender.restoreState(state, file) to resume after reconnect
}