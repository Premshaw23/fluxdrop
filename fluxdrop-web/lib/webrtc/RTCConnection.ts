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

  async initialize(role: 'sender' | 'receiver') {
    const configuration: RTCConfiguration = {
      iceServers: [
        {
          urls: process.env.NEXT_PUBLIC_STUN_SERVER || 'stun:stun.l.google.com:19302'
        }
        // TURN servers will be added in Week 4
      ]
    };

    this.peerConnection = new RTCPeerConnection(configuration);

    // Handle ICE candidates
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        this.onIceCandidate(event.candidate);
      }
    };

    // Handle connection state changes
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      console.log('📡 Connection state:', state);
      
      if (state) {
        this.config.onStateChange?.(state as ConnectionState);
      }

      if (state === 'failed' || state === 'closed') {
        this.config.onError?.(new Error(`Connection ${state}`));
      }
    };

    // Handle ICE connection state
    this.peerConnection.oniceconnectionstatechange = () => {
      console.log('🧊 ICE state:', this.peerConnection?.iceConnectionState);
    };

    if (role === 'sender') {
      await this.createDataChannel();
    } else {
      this.setupDataChannelListener();
    }
  }

  private async createDataChannel() {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    this.dataChannel = this.peerConnection.createDataChannel('fileTransfer', {
      ordered: true,
      maxRetransmits: 3
    });

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
    if (!this.dataChannel) return;

    this.dataChannel.binaryType = 'arraybuffer';

    this.dataChannel.onopen = () => {
      console.log('✅ Data channel opened');
      this.config.onDataChannelOpen?.();
    };

    this.dataChannel.onclose = () => {
      console.log('👋 Data channel closed');
      this.config.onDataChannelClose?.();
    };

    this.dataChannel.onmessage = (event) => {
      console.log('[RTCConnection] Data channel received message, bytes:', event.data?.byteLength);
      if (event.data instanceof ArrayBuffer) {
        this.config.onMessage?.(event.data);
      } else {
        console.warn('[RTCConnection] Received non-ArrayBuffer message:', event.data);
      }
    };

    this.dataChannel.onerror = (error) => {
      console.error('❌ Data channel error:', error);
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
      // RTCDataChannel.send accepts ArrayBuffer, string, or Blob
      if (data instanceof ArrayBuffer) {
        this.dataChannel.send(data);
        console.log('[RTCConnection] Sent ArrayBuffer, bytes:', data.byteLength);
      } else if (data instanceof Uint8Array) {
        // Copy only the relevant bytes into a new ArrayBuffer
        const arr = new Uint8Array(data.byteLength);
        arr.set(data);
        this.dataChannel.send(arr.buffer);
        console.log('[RTCConnection] Sent Uint8Array, bytes:', arr.byteLength);
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
}