// fluxdrop-web/lib/transfer/FileTransfer.ts

const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  chunks: number;
}

export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speed: number; // bytes per second
  timeRemaining: number; // seconds
  currentChunk: number;
  totalChunks: number;
}

interface ChunkMessage {
  type: 'metadata' | 'chunk' | 'complete';
  metadata?: FileMetadata;
  chunkIndex?: number;
  data?: ArrayBuffer;
}

export class FileTransferSender {
  private file: File | null = null;
  private chunks: Blob[] = [];
  private currentChunk = 0;
  private startTime = 0;
  private bytesSent = 0;
  private isCancelled = false;

  public onProgress?: (progress: TransferProgress) => void;
  public onComplete?: () => void;
  public onError?: (error: Error) => void;

  constructor(
    private sendData: (data: ArrayBuffer | Uint8Array) => boolean,
    private getBufferedAmount: () => number
  ) {}

  async startTransfer(file: File) {
    this.file = file;
    this.chunks = this.createChunks(file);
    this.currentChunk = 0;
    this.bytesSent = 0;
    this.isCancelled = false;
    this.startTime = Date.now();

    console.log(`📤 Starting transfer: ${file.name} (${file.size} bytes, ${this.chunks.length} chunks)`);

    // Send metadata first
    const metadata: FileMetadata = {
      name: file.name,
      size: file.size,
      type: file.type,
      chunks: this.chunks.length
    };

    this.sendMessage({ type: 'metadata', metadata });

    // Start sending chunks
    await this.sendNextChunk();
  }

  private createChunks(file: File): Blob[] {
    const chunks: Blob[] = [];
    let offset = 0;

    while (offset < file.size) {
      const chunk = file.slice(offset, offset + CHUNK_SIZE);
      chunks.push(chunk);
      offset += CHUNK_SIZE;
    }

    return chunks;
  }

  private async sendNextChunk() {
    if (this.isCancelled) {
      console.log('❌ Transfer cancelled');
      return;
    }

    if (this.currentChunk >= this.chunks.length) {
      this.sendMessage({ type: 'complete' });
      this.onComplete?.();
      console.log('✅ Transfer complete');
      return;
    }

    // Check buffer - wait if too much data is buffered
    const buffered = this.getBufferedAmount();
    if (buffered > CHUNK_SIZE * 2) {
      setTimeout(() => this.sendNextChunk(), 100);
      return;
    }

    const chunk = this.chunks[this.currentChunk];
    const arrayBuffer = await chunk.arrayBuffer();

    // Send chunk with index
    this.sendMessage({
      type: 'chunk',
      chunkIndex: this.currentChunk,
      data: arrayBuffer
    });

    this.bytesSent += arrayBuffer.byteLength;
    this.currentChunk++;

    // Update progress
    this.updateProgress();

    // Send next chunk
    setTimeout(() => this.sendNextChunk(), 0);
  }

  private updateProgress() {
    if (!this.file) return;

    const elapsed = (Date.now() - this.startTime) / 1000; // seconds
    const speed = elapsed > 0 ? this.bytesSent / elapsed : 0;
    const remaining = this.file.size - this.bytesSent;
    const timeRemaining = speed > 0 ? remaining / speed : 0;

    const progress: TransferProgress = {
      bytesTransferred: this.bytesSent,
      totalBytes: this.file.size,
      percentage: (this.bytesSent / this.file.size) * 100,
      speed,
      timeRemaining,
      currentChunk: this.currentChunk,
      totalChunks: this.chunks.length
    };

    this.onProgress?.(progress);
  }

  private sendMessage(message: ChunkMessage) {
    const encoder = new TextEncoder();
    const json = JSON.stringify({
      type: message.type,
      metadata: message.metadata,
      chunkIndex: message.chunkIndex
    });

    // Send header
    const header = encoder.encode(json);
    const headerLength = new Uint32Array([header.length]);
    
    if (message.data) {
      // Send: [header length (4 bytes)][header][data]
      const combined = new Uint8Array(4 + header.length + message.data.byteLength);
      combined.set(new Uint8Array(headerLength.buffer), 0);
      combined.set(header, 4);
      combined.set(new Uint8Array(message.data), 4 + header.length);
      const result = this.sendData(combined);
      console.log(`[FileTransferSender] Sent chunk ${message.chunkIndex}, type=${message.type}, bytes=${combined.length}, sendData returned:`, result);
    } else {
      // Send: [header length (4 bytes)][header]
      const combined = new Uint8Array(4 + header.length);
      combined.set(new Uint8Array(headerLength.buffer), 0);
      combined.set(header, 4);
      const result = this.sendData(combined);
      console.log(`[FileTransferSender] Sent message type=${message.type}, bytes=${combined.length}, sendData returned:`, result);
    }
  }

  cancel() {
    this.isCancelled = true;
  }
}

export class FileTransferReceiver {
  private metadata: FileMetadata | null = null;
  private receivedChunks = new Map<number, ArrayBuffer>();
  private startTime = 0;
  private bytesReceived = 0;

  public onMetadata?: (metadata: FileMetadata) => void;
  public onProgress?: (progress: TransferProgress) => void;
  public onComplete?: (file: Blob) => void;
  public onError?: (error: Error) => void;

  handleMessage(data: ArrayBuffer) {
    console.log('[FileTransferReceiver] Received message, bytes:', data.byteLength);
    const message = this.parseMessage(data);
    console.log('[FileTransferReceiver] Parsed message:', message);

    switch (message.type) {
      case 'metadata':
        this.handleMetadata(message.metadata!);
        break;
      case 'chunk':
        this.handleChunk(message.chunkIndex!, message.data!);
        break;
      case 'complete':
        this.handleComplete();
        break;
      default:
        console.warn('[FileTransferReceiver] Unknown message type:', message.type);
    }
  }

  private parseMessage(data: ArrayBuffer): ChunkMessage {
    const view = new DataView(data);
    const headerLength = view.getUint32(0, true);
    const headerBytes = new Uint8Array(data, 4, headerLength);
    const decoder = new TextDecoder();
    const headerJson = decoder.decode(headerBytes);
    const header = JSON.parse(headerJson);

    if (header.type === 'chunk') {
      const chunkData = data.slice(4 + headerLength);
      return {
        type: 'chunk',
        chunkIndex: header.chunkIndex,
        data: chunkData
      };
    }

    return header;
  }

  private handleMetadata(metadata: FileMetadata) {
    this.metadata = metadata;
    this.receivedChunks.clear();
    this.bytesReceived = 0;
    this.startTime = Date.now();

    console.log(`📥 Receiving: ${metadata.name} (${metadata.size} bytes, ${metadata.chunks} chunks)`);
    this.onMetadata?.(metadata);
  }

  private handleChunk(index: number, data: ArrayBuffer) {
    if (!this.metadata) {
      console.error('❌ Received chunk before metadata');
      return;
    }

    this.receivedChunks.set(index, data);
    this.bytesReceived += data.byteLength;

    this.updateProgress();
  }

  private updateProgress() {
    if (!this.metadata) return;

    const elapsed = (Date.now() - this.startTime) / 1000;
    const speed = elapsed > 0 ? this.bytesReceived / elapsed : 0;
    const remaining = this.metadata.size - this.bytesReceived;
    const timeRemaining = speed > 0 ? remaining / speed : 0;

    const progress: TransferProgress = {
      bytesTransferred: this.bytesReceived,
      totalBytes: this.metadata.size,
      percentage: (this.bytesReceived / this.metadata.size) * 100,
      speed,
      timeRemaining,
      currentChunk: this.receivedChunks.size,
      totalChunks: this.metadata.chunks
    };

    this.onProgress?.(progress);
  }

  private handleComplete() {
    if (!this.metadata) {
      this.onError?.(new Error('No metadata received'));
      return;
    }

    // Combine all chunks in order
    const chunks: ArrayBuffer[] = [];
    for (let i = 0; i < this.metadata.chunks; i++) {
      const chunk = this.receivedChunks.get(i);
      if (!chunk) {
        this.onError?.(new Error(`Missing chunk ${i}`));
        return;
      }
      chunks.push(chunk);
    }

    const blob = new Blob(chunks, { type: this.metadata.type });
    console.log('✅ Transfer complete, file reconstructed');
    this.onComplete?.(blob);
  }

  reset() {
    this.metadata = null;
    this.receivedChunks.clear();
    this.bytesReceived = 0;
  }
}

// Utility functions
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

export function formatSpeed(bytesPerSecond: number): string {
  return formatBytes(bytesPerSecond) + '/s';
}

export function formatTime(seconds: number): string {
  if (seconds < 60) return Math.round(seconds) + 's';
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${minutes}m ${secs}s`;
}