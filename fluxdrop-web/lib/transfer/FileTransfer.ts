import { encryptAESGCM, sha256, decryptAESGCM } from '../crypto/crypto';
export interface BatchMetadata {
  files: FileMetadata[];
}
// fluxdrop-web/lib/transfer/FileTransfer.ts

export let CHUNK_SIZE = 192 * 1024; // Default 192KB

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
  type: 'batch-metadata' | 'metadata' | 'chunk' | 'complete' | 'resume-request';
  missingChunks?: number[];
  batchMetadata?: BatchMetadata;
  metadata?: FileMetadata;
  chunkIndex?: number;
  data?: ArrayBuffer;
  iv?: number[]; // for encrypted chunks
  hash?: string; // base64-encoded SHA-256 hash
}

export class FileTransferSender {
                          /**
                           * Debug: log current state before starting batch transfer
                           */
                          private debugState(label: string) {
                            console.log(`[FileTransferSender][DEBUG] ${label}:`, {
                              files: this.files,
                              fileIndex: this._fileIndex,
                              chunks: this.chunks?.length,
                              isCancelled: this.isCancelled,
                              dataChannelState: typeof this.getDataChannelState === 'function' ? this.getDataChannelState() : 'unknown',
                            });
                          }
                        public onUserError?: (message: string) => void;
                        public onNetworkStatusChange?: (online: boolean) => void;
                        private errorLog: string[] = [];
                      private _networkOnline: boolean = navigator.onLine;
                      private _networkListenerAdded: boolean = false;

                      /**
                       * Start listening for network status changes
                       */
                      public enableNetworkStatusListener() {
                        if (this._networkListenerAdded) return;
                        window.addEventListener('online', this._handleNetworkOnline);
                        window.addEventListener('offline', this._handleNetworkOffline);
                        this._networkListenerAdded = true;
                      }

                      private _handleNetworkOnline = () => {
                        this._networkOnline = true;
                        console.log('[Network] Online');
                        this.onNetworkStatusChange?.(true);
                      };
                      private _handleNetworkOffline = () => {
                        this._networkOnline = false;
                        console.log('[Network] Offline');
                        this.onNetworkStatusChange?.(false);
                      };
                    private sessionId: string = '';
                    public setSessionId(id: string) {
                      this.sessionId = id;
                    }
                  private connectionType: string = '';
                  private transferSuccess: boolean = false;
                  private static p2pSuccessCount: number = 0;
                  private static relaySuccessCount: number = 0;
                  private static transferCount: number = 0;
                private lastChunkSendTime: number = 0;
                private chunkSendTimings: number[] = [];
              private minChunkDelayMs: number = 0;

              /**
               * Set minimum delay (ms) between chunk sends for throttling
               */
              public setMinChunkDelay(ms: number) {
                this.minChunkDelayMs = ms;
              }
            private chunkBuffer: Array<ArrayBuffer | null> = [];
            private maxBufferedChunks: number = 10; // Only buffer 10 chunks at a time
          /**
           * Set chunk size for optimization (in bytes)
           */
          public static setChunkSize(size: number) {
            CHUNK_SIZE = size;
          }

          /**
           * Test chunking for different sizes, returns array of chunk counts
           */
          public static testChunkSizes(file: File, sizes: number[]): number[] {
            return sizes.map(sz => Math.ceil(file.size / sz));
          }
        /**
         * Detect if file has changed during transfer (by name, size, type)
         */
        public hasFileChanged(newFile: File): boolean {
          if (!this.file) return false;
          return (
            this.file.name !== newFile.name ||
            this.file.size !== newFile.size ||
            this.file.type !== newFile.type
          );
        }
      /**
       * Verify chunk integrity before/after resend (optional, for resumed chunks)
       */
      public async verifyChunk(idx: number): Promise<boolean> {
        if (!this.chunks || !this.file) return false;
        if (idx < 0 || idx >= this.chunks.length) return false;
        const chunk = this.chunks[idx];
        let arrayBuffer = await chunk.arrayBuffer();
        const hashBuffer = await sha256(arrayBuffer);
        const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
        // Optionally compare with previously sent hash if stored
        return true; // Always true for now, extend as needed
      }
    /**
     * Handle resume-request from receiver, resend missing chunks
     */
    public async handleResumeRequest(missingChunks: number[]) {
      if (!this.chunks || !this.file) return;
      for (const idx of missingChunks) {
        if (idx >= 0 && idx < this.chunks.length && !this.sentChunkBitmap[idx]) {
          const chunk = this.chunks[idx];
          let arrayBuffer = await chunk.arrayBuffer();
          let iv: Uint8Array | undefined = undefined;
          const hashBuffer = await sha256(arrayBuffer);
          const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
          if (this.encryptionKey) {
            const ivRaw = window.crypto.getRandomValues(new Uint8Array(12));
            iv = new Uint8Array(ivRaw.buffer.slice(0));
            arrayBuffer = await encryptAESGCM(this.encryptionKey, arrayBuffer, iv as BufferSource);
          }
          this.sendMessage({
            type: 'chunk',
            chunkIndex: idx,
            data: arrayBuffer,
            ...(iv ? { iv: Array.from(iv) } : {}),
            hash: hashB64
          });
          this.sentChunkBitmap[idx] = true;
        }
      }
    }
  private encryptionKey: CryptoKey | null = null;

  /**
   * Optionally set an AES-GCM key for encrypting chunks
   */
  setEncryptionKey(key: CryptoKey) {
    this.encryptionKey = key;
  }
  private files: File[] = [];
  private _fileIndex = 0;
  public get fileIndex() {
    return this._fileIndex;
  }

  /**
   * Start batch transfer for multiple files
   */
  public async startBatchTransfer(files: File[]) {
    this.files = files;
    this._fileIndex = 0;
    this.debugState('startBatchTransfer called');
    // Prepare batch metadata
    const batchMetadata: BatchMetadata = {
      files: files.map(f => ({
        name: f.name,
        size: f.size,
        type: f.type,
        chunks: Math.ceil(f.size / CHUNK_SIZE)
      }))
    };
    console.log('[FileTransferSender] Sending batch-metadata:', batchMetadata);
    this.sendMessage({ type: 'batch-metadata', batchMetadata });
    await this.startNextFile();
    this.debugState('startNextFile called');
    this.debugState('sendNextChunk called');
  }

    private async startNextFile() {
            // Log connection type for P2P success rate
            if (typeof (window as any).currentConnectionType === 'string') {
              this.connectionType = (window as any).currentConnectionType;
              console.log(`[P2P Test] Connection type: ${this.connectionType}`);
            }
      if (this._fileIndex >= this.files.length) {
        this.onComplete?.();
        return;
      }
      const file = this.files[this._fileIndex];
      this.file = file;
      this.chunks = this.createChunks(file);
      this.currentChunk = 0;
      this.bytesSent = 0;
      this.startTime = Date.now();
      this.sentChunkBitmap = new Array(this.chunks.length).fill(false);
      // Preload chunk buffers for current file
      this.chunkBuffer = new Array(this.chunks.length).fill(null);
      // Preload only the first N chunks
      for (let i = 0; i < Math.min(this.chunks.length, this.maxBufferedChunks); i++) {
        this.chunks[i].arrayBuffer().then(buf => { this.chunkBuffer[i] = buf; });
      }

      // Send metadata for this file
      const metadata: FileMetadata = {
        name: file.name,
        size: file.size,
        type: file.type,
        chunks: this.chunks.length
      };
      this.sendMessage({ type: 'metadata', metadata });

      await this.sendNextChunk();
    }
  private file: File | null = null;
  private chunks: Blob[] = [];
  private currentChunk = 0;
  private startTime = 0;
  private bytesSent = 0;
  private isCancelled = false;
  private chunkRetryCounts: Record<number, number> = {};
  private readonly maxChunkRetries = 3;

  /**
   * Add error to internal log
   */
  private logError(msg: string) {
    const timestamp = new Date().toLocaleTimeString();
    this.errorLog.push(`[${timestamp}] ${msg}`);
    // Also print to console for dev
    console.error(`[FileTransferSender] ${msg}`);
  }

  /**
   * Get error log
   */
  public getErrorLog(): string[] {
    return [...this.errorLog];
  }
  private sentChunkBitmap: boolean[] = [];
    /**
     * Serialize current transfer state for reconnect/resume
     */
    public serializeState(): any {
      if (!this.file) return null;
      return {
        fileIndex: this._fileIndex,
        fileName: this.file.name,
        fileSize: this.file.size,
        fileType: this.file.type,
        currentChunk: this.currentChunk,
        totalChunks: this.chunks.length,
        bytesSent: this.bytesSent,
        startTime: this.startTime,
      };
    }

    /**
     * Restore transfer state after reconnect
     */
    /**
     * Restore transfer state after reconnect, optionally resume from a specific chunk
     */
    public restoreState(state: any, file: File, resumeChunkIndex?: number) {
      if (!state || !file) return;
      this.file = file;
      this.chunks = this.createChunks(file);
      this._fileIndex = state.fileIndex;
      this.currentChunk = typeof resumeChunkIndex === 'number' ? resumeChunkIndex : state.currentChunk;
      this.bytesSent = state.bytesSent;
      this.startTime = state.startTime || Date.now();
      this.isCancelled = false;
      this.sendNextChunk();
    }

  public onProgress?: (progress: TransferProgress) => void;
  public onComplete?: () => void;
  public onError?: (error: Error) => void;

  constructor(
    private sendData: (data: ArrayBuffer | Uint8Array) => boolean,
    private getBufferedAmount: () => number,
    private getDataChannelState?: () => string
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
    let chunkIndex = 0;
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const chunk = file.slice(offset, end);
      // Log detailed chunk slicing info
      console.log(`[FileTransferSender] createChunks: chunk ${chunkIndex}, offset: ${offset}, end: ${end}, size: ${chunk.size}`);
      chunks.push(chunk);
      offset = end;
      chunkIndex++;
    }
    // Log total chunks and file size
    const totalSize = chunks.reduce((acc, c) => acc + c.size, 0);
    console.log(`[FileTransferSender] createChunks: total chunks: ${chunks.length}, file.size: ${file.size}, sum(chunk.size): ${totalSize}`);
    return chunks;
  }

  private async sendNextChunk() {
            // On last chunk, log transfer success and update counters
            if (this.currentChunk === this.chunks.length - 1) {
              this.transferSuccess = true;
              FileTransferSender.transferCount++;
              if (this.connectionType === 'P2P direct') FileTransferSender.p2pSuccessCount++;
              if (this.connectionType === 'TURN relay') FileTransferSender.relaySuccessCount++;
              console.log(`[P2P Test] Transfer complete. P2P: ${FileTransferSender.p2pSuccessCount}, Relay: ${FileTransferSender.relaySuccessCount}, Total: ${FileTransferSender.transferCount}`);
            }
        const now = Date.now();
        if (this.lastChunkSendTime) {
          const delta = now - this.lastChunkSendTime;
          this.chunkSendTimings.push(delta);
          if (this.chunkSendTimings.length % 10 === 0) {
            const avg = this.chunkSendTimings.reduce((a, b) => a + b, 0) / this.chunkSendTimings.length;
            console.log(`[Profile] Avg chunk send interval: ${avg.toFixed(2)} ms over ${this.chunkSendTimings.length} chunks`);
          }
        }
        this.lastChunkSendTime = now;
        // Log buffer usage
        if (this.chunkBuffer) {
          const buffered = this.chunkBuffer.filter(b => b !== null).length;
          if (this.currentChunk % 10 === 0) {
            console.log(`[Profile] Buffered chunks: ${buffered}/${this.chunkBuffer.length}`);
          }
        }
    if (this.isCancelled) {
      const msg = 'Transfer cancelled by user or system.';
      console.log('❌', msg);
      this.onUserError?.(msg);
      return;
    }

    if (this.currentChunk >= this.chunks.length) {
      this.sendMessage({ type: 'complete' });
      this._fileIndex++;
      await this.startNextFile();
      return;
    }

    // Check retry count for current chunk
    if (!this.chunkRetryCounts[this.currentChunk]) {
      this.chunkRetryCounts[this.currentChunk] = 0;
    }
    if (this.chunkRetryCounts[this.currentChunk] >= this.maxChunkRetries) {
      this.logError(`Max retries reached for chunk ${this.currentChunk}. Aborting transfer.`);
      this.onError?.(new Error(`Max retries reached for chunk ${this.currentChunk}`));
      this.isCancelled = true;
      return;
    }

    // Even stricter throttling: only send if buffer is very low
    const buffered = this.getBufferedAmount();
    if (buffered > CHUNK_SIZE * 2) {
      setTimeout(() => this.sendNextChunk(), 120);
      return;
    }

    let arrayBuffer: ArrayBuffer;
    if (this.chunkBuffer[this.currentChunk]) {
      arrayBuffer = this.chunkBuffer[this.currentChunk]!;
    } else {
      arrayBuffer = await this.chunks[this.currentChunk].arrayBuffer();
      // Only buffer if within maxBufferedChunks window
      if (this.currentChunk < this.maxBufferedChunks) {
        this.chunkBuffer[this.currentChunk] = arrayBuffer;
      }
    }
    // Release buffer for sent chunk to save memory
    if (this.currentChunk > 0 && this.currentChunk - 1 < this.chunkBuffer.length) {
      this.chunkBuffer[this.currentChunk - 1] = null;
    }
    // Log first 16 bytes of chunk before encryption
    const preEncHex = Array.from(new Uint8Array(arrayBuffer).slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`[FileTransferSender] Chunk ${this.currentChunk} pre-encryption first 16 bytes: ${preEncHex}`);
    // Compute SHA-256 hash (base64) on unencrypted chunk
    const hashBuffer = await sha256(arrayBuffer);
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
    let iv: Uint8Array | undefined = undefined;
    if (this.encryptionKey) {
      // Generate random 12-byte IV
      const ivRaw = window.crypto.getRandomValues(new Uint8Array(12));
      iv = new Uint8Array(ivRaw.buffer.slice(0)); // Ensure iv is a plain Uint8Array backed by ArrayBuffer
      arrayBuffer = await encryptAESGCM(this.encryptionKey, arrayBuffer, iv as BufferSource);
      // Log first 16 bytes after encryption
      const postEncHex = Array.from(new Uint8Array(arrayBuffer).slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`[FileTransferSender] Chunk ${this.currentChunk} post-encryption first 16 bytes: ${postEncHex}`);
    }

    // Log chunk info
    console.log(`[FileTransferSender] Sending chunk ${this.currentChunk}/${this.chunks.length - 1}, size: ${arrayBuffer.byteLength}`);

    // Send chunk with index, IV (if encrypted), and hash
    this.sendMessage({
      type: 'chunk',
      chunkIndex: this.currentChunk,
      data: arrayBuffer,
      ...(iv ? { iv: Array.from(iv) } : {}),
      hash: hashB64
    });

    this.bytesSent += arrayBuffer.byteLength;
    this.sentChunkBitmap[this.currentChunk] = true;
    this.currentChunk++;

    // Update progress
    this.updateProgress();

    // Send next chunk with optional throttling
    setTimeout(() => this.sendNextChunk(), this.minChunkDelayMs);
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
    // Log progress for load testing with multiple sessions
    if (this.sessionId && (this.currentChunk % 50 === 0 || progress.percentage === 100)) {
      console.log(`[LoadTest] Session ${this.sessionId}: ${progress.percentage.toFixed(2)}%, Speed: ${formatSpeed(progress.speed)}, Chunk: ${this.currentChunk}/${this.chunks.length}`);
    }
    // Log progress for slow network and large file testing
    if (this.currentChunk % 50 === 0 || progress.percentage === 100) {
      console.log(`[Test] Progress: ${progress.percentage.toFixed(2)}%, Speed: ${formatSpeed(progress.speed)}, Remaining: ${formatTime(progress.timeRemaining)}, Chunk: ${this.currentChunk}/${this.chunks.length}`);
    }
  }

  private sendMessage(message: ChunkMessage) {
    // Check if data channel is open before sending
    if (this.getDataChannelState && this.getDataChannelState() !== 'open') {
      const msg = 'Connection lost. Retrying chunk send...';
      this.logError(msg);
      this.onUserError?.(msg);
      // Increment retry count for current chunk
      if (typeof this.currentChunk === 'number') {
        this.chunkRetryCounts[this.currentChunk] = (this.chunkRetryCounts[this.currentChunk] || 0) + 1;
      }
      setTimeout(() => this.sendNextChunk(), 500);
      return;
    }
    const encoder = new TextEncoder();
    // Build header with all relevant fields
    const headerObj: any = {
      type: message.type,
      metadata: message.metadata,
      chunkIndex: message.chunkIndex
    };
    if (message.iv) headerObj.iv = message.iv;
    if (message.hash) headerObj.hash = message.hash;
    if (message.batchMetadata) headerObj.batchMetadata = message.batchMetadata;

    const json = JSON.stringify(headerObj);
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
    this.logError('Transfer cancelled by user or system.');
  }
}

export class FileTransferReceiver {
          private errorLog: string[] = [];
          /**
           * Add error to internal log
           */
          private logError(msg: string) {
            const timestamp = new Date().toLocaleTimeString();
            this.errorLog.push(`[${timestamp}] ${msg}`);
            // Also print to console for dev
            console.error(`[FileTransferReceiver] ${msg}`);
          }

          /**
           * Get error log
           */
          public getErrorLog(): string[] {
            return [...this.errorLog];
          }
        /**
         * Detect if metadata changed (file changed during transfer)
         */
        public hasMetadataChanged(newMetadata: FileMetadata): boolean {
          if (!this.metadata) return false;
          return (
            this.metadata.name !== newMetadata.name ||
            this.metadata.size !== newMetadata.size ||
            this.metadata.type !== newMetadata.type
          );
        }
      /**
       * Verify integrity of received chunk (hash check)
       */
      public async verifyReceivedChunk(idx: number, expectedHash: string): Promise<boolean> {
        if (!this.receivedChunks.has(idx)) return false;
        const chunkData = this.receivedChunks.get(idx)!;
        const hashBuffer = await sha256(chunkData);
        const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
        return hashB64 === expectedHash;
      }
    /**
     * Request missing chunks from sender after reconnect
     */
    public requestMissingChunks(sendControlMessage: (msg: ChunkMessage) => void) {
      if (!this.metadata) return;
      const missing: number[] = [];
      for (let i = 0; i < this.metadata.chunks; i++) {
        if (!this.receivedChunkBitmap[i]) missing.push(i);
      }
      if (missing.length > 0) {
        sendControlMessage({ type: 'resume-request', missingChunks: missing });
      }
    }
  private decryptionKey: CryptoKey | null = null;
  private receivedChunkBitmap: boolean[] = [];

  /**
   * Optionally set an AES-GCM key for decrypting chunks
   */
  setDecryptionKey(key: CryptoKey) {
    this.decryptionKey = key;
  }
  private metadata: FileMetadata | null = null;
  private receivedChunks = new Map<number, ArrayBuffer>();
  private startTime = 0;
  private bytesReceived = 0;

  public onMetadata?: (metadata: FileMetadata) => void;
  public onProgress?: (progress: TransferProgress) => void;
    public onComplete?: (file: Blob, fileIndex: number) => void;
  public onError?: (error: Error) => void;
  public onBatchMetadata?: (batchMetadata: BatchMetadata) => void;

  async handleMessage(data: ArrayBuffer) {
    console.log('[FileTransferReceiver] Received message, bytes:', data.byteLength);
    const message = this.parseMessage(data);
    console.log('[FileTransferReceiver] Parsed message:', message);

    switch (message.type) {
      case 'batch-metadata':
        console.log('[FileTransferReceiver] batch-metadata handler:', message, message.batchMetadata);
        if (this.onBatchMetadata) {
          this.currentFileIndex = 0; // Reset file index for new batch
          this.onBatchMetadata(message.batchMetadata!);
        }
        break;
      case 'metadata':
        this.handleMetadata(message.metadata!);
        break;
      case 'chunk':
        await this.handleChunk(message.chunkIndex!, message.data!, message.iv, message.hash);
        break;
      case 'complete':
        await this.handleComplete();
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
        ...header,
        data: chunkData
      };
    }

    // For non-chunk messages, return all header properties (not just type)
    return { ...header };
  }

  private handleMetadata(metadata: FileMetadata) {
    this.metadata = metadata;
    this.receivedChunks.clear();
    this.bytesReceived = 0;
    this.startTime = Date.now();
      this.receivedChunkBitmap = new Array(metadata.chunks).fill(false);

    console.log(`📥 Receiving: ${metadata.name} (${metadata.size} bytes, ${metadata.chunks} chunks)`);
    this.onMetadata?.(metadata);
  }

  private async handleChunk(index: number, data: ArrayBuffer, iv?: number[], hash?: string) {
    if (!this.metadata) {
      console.error('❌ Received chunk before metadata');
      if (this.onError) this.onError(new Error('Received chunk before metadata'));
      return;
    }

    let chunkData: ArrayBuffer;
    // Log decryption key and IV presence
    console.log(`[FileTransferReceiver] handleChunk: index=${index}, hasDecryptionKey=${!!this.decryptionKey}, hasIV=${!!iv}, IV=`, iv);
    if (this.decryptionKey && iv) {
      // Log first 16 bytes before decryption
      const preDecHex = Array.from(new Uint8Array(data).slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`[FileTransferReceiver] Chunk ${index} pre-decryption first 16 bytes: ${preDecHex}`);
      try {
        chunkData = await decryptAESGCM(this.decryptionKey, data, new Uint8Array(iv));
        // Log first 16 bytes after decryption
        const postDecHex = Array.from(new Uint8Array(chunkData).slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`[FileTransferReceiver] Chunk ${index} post-decryption first 16 bytes: ${postDecHex}`);
      } catch (e) {
        console.error('❌ Decryption failed for chunk', index, e);
        this.onError?.(new Error('Decryption failed for chunk ' + index));
        return;
      }
    } else if (!this.decryptionKey && iv) {
      // Encrypted chunk but no decryption key: error
      console.warn(`[FileTransferReceiver] Warning: Received encrypted chunk but no decryption key for chunk ${index}`);
      chunkData = data;
    } else if (this.decryptionKey && !iv) {
      // Decryption key present but IV missing
      console.warn(`[FileTransferReceiver] Warning: Decryption key present but IV missing for chunk ${index}`);
      chunkData = data;
    } else {
      // Not encrypted
      console.log(`[FileTransferReceiver] Info: Not encrypted, storing raw chunk for index ${index}`);
      chunkData = data;
    }
    // Verify SHA-256 hash if provided
    if (hash) {
      const hashBuffer = await sha256(chunkData);
      const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
      if (hashB64 !== hash) {
        this.logError(`Chunk integrity check failed for chunk ${index} (expected: ${hash}, actual: ${hashB64})`);
        this.onError?.(new Error('Chunk integrity check failed for chunk ' + index));
        return;
      }
    }
    this.receivedChunks.set(index, chunkData);
    this.receivedChunkBitmap[index] = true;
    this.bytesReceived += chunkData.byteLength;
    console.log(`[FileTransferReceiver] Received chunk ${index}/${this.metadata.chunks - 1}, size: ${chunkData.byteLength}`);
    const receivedIndices = Array.from(this.receivedChunks.keys()).sort((a, b) => a - b);
    console.log(`[FileTransferReceiver] All received chunk indices:`, receivedIndices, `Total bytes received: ${this.bytesReceived}`);
    // Verbose: print bitmap
    console.log(`[FileTransferReceiver] Chunk bitmap:`, this.receivedChunkBitmap);
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

  private currentFileIndex = 0;
  private async handleComplete() {
    if (!this.metadata) {
      this.onError?.(new Error('No metadata received'));
      return;
    }

    // Combine all chunks in order
    const chunks: ArrayBuffer[] = [];
    for (let i = 0; i < this.metadata.chunks; i++) {
      const chunk = this.receivedChunks.get(i);
      if (!chunk) {
        console.error(`[FileTransferReceiver] Missing chunk ${i} of ${this.metadata.chunks}`);
        if (this.onError) this.onError(new Error(`Missing chunk ${i}`));
        // Verbose: print all received indices and bitmap
        console.log(`[FileTransferReceiver] Missing chunk debug:`, {
          receivedIndices: Array.from(this.receivedChunks.keys()),
          bitmap: this.receivedChunkBitmap
        });
        return;
      }
      chunks.push(chunk);
    }

    const blob = new Blob(chunks, { type: this.metadata.type });
    // Calculate SHA-256 hash of the reconstructed file
    const arrayBuffer = await blob.arrayBuffer();
    // Log first 16 bytes of reconstructed file
    const reassembledHex = Array.from(new Uint8Array(arrayBuffer).slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const hashBuffer = await sha256(arrayBuffer);
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
    console.log('✅ Transfer complete, file reconstructed:', {
      name: this.metadata.name,
      type: this.metadata.type,
      size: blob.size,
      blobType: blob.type,
      sha256: hashB64,
      first16: reassembledHex
    });
    if (typeof this.onComplete === 'function') {
      console.log(`[FileTransferReceiver] Calling onComplete for fileIndex=${this.currentFileIndex}, blob.size=${blob.size}`);
      this.onComplete(blob, this.currentFileIndex);
    } else {
      console.warn('[FileTransferReceiver] onComplete handler not set');
    }
    this.currentFileIndex++;
    // Wait for next metadata to start next file
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