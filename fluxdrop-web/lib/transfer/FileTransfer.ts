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
  relativePath?: string;
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
  type: 'batch-metadata' | 'metadata' | 'chunk' | 'complete' | 'resume-request' | 'chunk-ack' | 'ack-all';
  missingChunks?: number[];
  batchMetadata?: BatchMetadata;
  metadata?: FileMetadata;
  chunkIndex?: number;
  data?: ArrayBuffer;
  iv?: number[]; // for encrypted chunks
  hash?: string; // base64-encoded SHA-256 hash
}

export class FileTransferSender {
  public onFileComplete?: (fileIndex: number) => void;
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
            private acknowledgedChunks: Set<number> = new Set(); // Track acknowledged chunks
            private ackWaitTimeout: NodeJS.Timeout | null = null; // Timeout for waiting for acks
            private readonly ACK_TIMEOUT_MS = 30000; // ✅ 30 second timeout for all acks
            private readonly ACK_BACKOFF_MS = [100, 200, 500, 1000, 2000]; // ✅ Exponential backoff
            private ackWaitStartTime: number = 0; // ✅ When we started waiting
            private ackWaitRetryCount: number = 0; // ✅ How many times we've waited
            private unackedCountThreshold: number = 50; // ✅ Pause if > N chunks unacked
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
        chunks: Math.ceil(f.size / CHUNK_SIZE),
        relativePath: (f as any).webkitRelativePath || f.name
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
      this.acknowledgedChunks.clear(); // ✅ Reset acknowledged chunks for new file
      this.ackWaitStartTime = 0; // ✅ Reset ack wait timer
      this.ackWaitRetryCount = 0; // ✅ Reset retry count
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
        chunks: this.chunks.length,
        relativePath: (file as any).webkitRelativePath || file.name
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
    // console.error(`[FileTransferSender] ${msg}`);
  }

  /**
   * Get error log
   */
  public getErrorLog(): string[] {
    return [...this.errorLog];
  }
  
  /**
   * Count how many chunks are unacknowledged
   */
  private countUnacknowledgedChunks(): number {
    if (!this.chunks) return 0;
    let count = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (!this.acknowledgedChunks.has(i)) {
        count++;
      }
    }
    return count;
  }
  
  /**
   * Get list of unacknowledged chunk indices
   */
  private getUnacknowledgedChunks(): number[] {
    if (!this.chunks) return [];
    const unacked: number[] = [];
    for (let i = 0; i < this.chunks.length; i++) {
      if (!this.acknowledgedChunks.has(i)) {
        unacked.push(i);
      }
    }
    return unacked;
  }

  /**
   * Handle chunk acknowledgment from receiver
   */
  public handleChunkAck(chunkIndex: number) {
    this.acknowledgedChunks.add(chunkIndex);
  }
  
  /**
   * Handle all-chunks-acked message from receiver
   */
  public handleAckAll() {
    if (this.chunks) {
      for (let i = 0; i < this.chunks.length; i++) {
        this.acknowledgedChunks.add(i);
      }
    }
  }
  
  /**
   * Handle incoming control messages (acks, etc.)
   */
  public handleMessage(data: ArrayBuffer) {
    const view = new DataView(data);
    const headerLength = view.getUint32(0, true);
    const headerBytes = new Uint8Array(data, 4, headerLength);
    const decoder = new TextDecoder();
    const headerJson = decoder.decode(headerBytes);
    const header = JSON.parse(headerJson);
    
    if (header.type === 'chunk-ack') {
      this.handleChunkAck(header.chunkIndex);
    } else if (header.type === 'ack-all') {
      this.handleAckAll();
    }
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
      // ✅ FIX: Wait for all chunks to be acknowledged with proper timeout
      if (!this.chunks) {
        this.onError?.(new Error('No chunks available'));
        return;
      }
      
      const unackedChunks = this.getUnacknowledgedChunks();
      
      if (unackedChunks.length > 0) {
        // Initialize wait timer on first call
        if (this.ackWaitStartTime === 0) {
          this.ackWaitStartTime = Date.now();
          this.ackWaitRetryCount = 0;
          console.log(`[FileTransferSender] Started waiting for acknowledgments. Pending: ${unackedChunks.length}/${this.chunks.length}`);
        }
        
        const elapsed = Date.now() - this.ackWaitStartTime;
        
        // Check timeout
        if (elapsed > this.ACK_TIMEOUT_MS) {
          const errorMsg = `Acknowledgment timeout after ${this.ACK_TIMEOUT_MS}ms. Missing chunks: [${unackedChunks.slice(0, 10).join(', ')}${unackedChunks.length > 10 ? '...' : ''}]`;
          console.error(`[FileTransferSender] ${errorMsg}`);
          this.logError(errorMsg);
          this.onError?.(new Error(errorMsg));
          this.isCancelled = true;
          return;
        }
        
        // Exponential backoff
        const backoffIndex = Math.min(this.ackWaitRetryCount, this.ACK_BACKOFF_MS.length - 1);
        const waitTime = this.ACK_BACKOFF_MS[backoffIndex];
        this.ackWaitRetryCount++;
        
        console.log(`[FileTransferSender] Waiting for acks (${elapsed}ms/${this.ACK_TIMEOUT_MS}ms). Pending: ${unackedChunks.length}. Waiting ${waitTime}ms...`);
        
        // Recursively check again after waiting
        await new Promise(resolve => setTimeout(resolve, waitTime));
        this.sendNextChunk();
        return;
      }
      
      // All chunks acknowledged, safe to complete
      console.log(`[FileTransferSender] All chunks acknowledged. Completing transfer.`);
      if (typeof this.onFileComplete === 'function') {
        this.onFileComplete(this._fileIndex);
      }
      this.ackWaitStartTime = 0; // Reset for next file
      this.ackWaitRetryCount = 0;
      this.acknowledgedChunks.clear();
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

    // ✅ Backpressure: pause if too many unacknowledged chunks
    const unackedCount = this.countUnacknowledgedChunks();
    if (unackedCount > this.unackedCountThreshold) {
      console.log(`[FileTransferSender] Backpressure: ${unackedCount} chunks unacked. Pausing...`);
      setTimeout(() => this.sendNextChunk(), 200);
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

  // FIX 1: Proper sendMessage with endianness handling
  private sendMessage(message: ChunkMessage) {
    if (this.getDataChannelState && this.getDataChannelState() !== 'open') {
      const msg = 'Connection lost. Retrying chunk send...';
      this.logError(msg);
      this.onUserError?.(msg);
      if (typeof this.currentChunk === 'number') {
        this.chunkRetryCounts[this.currentChunk] = (this.chunkRetryCounts[this.currentChunk] || 0) + 1;
      }
      setTimeout(() => this.sendNextChunk(), 500);
      return;
    }

    const encoder = new TextEncoder();
    const headerObj: any = {
      type: message.type,
      metadata: message.metadata,
      chunkIndex: message.chunkIndex
    };
    if (message.iv) headerObj.iv = message.iv;
    if (message.hash) headerObj.hash = message.hash;
    if (message.batchMetadata) headerObj.batchMetadata = message.batchMetadata;

    const json = JSON.stringify(headerObj);
    const header = encoder.encode(json);
    
    // FIX: Use DataView for proper endianness (little-endian)
    const headerLengthBuffer = new ArrayBuffer(4);
    const headerLengthView = new DataView(headerLengthBuffer);
    headerLengthView.setUint32(0, header.length, true); // true = little-endian

    if (message.data) {
      // FIX: Ensure we're working with actual data, not views
      const dataBytes = new Uint8Array(message.data);
      const totalSize = 4 + header.length + dataBytes.byteLength;
      
      // Create combined buffer
      const combined = new Uint8Array(totalSize);
      combined.set(new Uint8Array(headerLengthBuffer), 0);
      combined.set(header, 4);
      combined.set(dataBytes, 4 + header.length);
      
      const result = this.sendData(combined);
      console.log(`[FileTransferSender] Sent chunk ${message.chunkIndex}, type=${message.type}, bytes=${totalSize}, sendData returned:`, result);
    } else {
      const combined = new Uint8Array(4 + header.length);
      combined.set(new Uint8Array(headerLengthBuffer), 0);
      combined.set(header, 4);
      const result = this.sendData(combined);
      console.log(`[FileTransferSender] Sent message type=${message.type}, bytes=${combined.byteLength}, sendData returned:`, result);
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
  private completeMessageReceived: boolean = false; // ✅ Track if 'complete' was received
  private readonly RECEIVER_WAIT_TIMEOUT_MS = 15000; // ✅ 15 seconds to wait for missing chunks
  private completeWaitStartTime: number = 0; // ✅ When we received 'complete' message

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
  private onSendControlMessage?: (msg: ChunkMessage) => void; // ✅ Callback to send control messages
  
  /**
   * Set callback to send control messages (acks, etc.)
   */
  public setSendControlMessage(callback: (msg: ChunkMessage) => void) {
    this.onSendControlMessage = callback;
  }
  
  /**
   * Send ack-all message to notify sender that all chunks received
   */
  private sendAckAll() {
    if (this.onSendControlMessage) {
      console.log('[FileTransferReceiver] Sending ack-all message to sender');
      this.onSendControlMessage({ type: 'ack-all' });
    }
  }

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
    this.completeMessageReceived = false; // ✅ Reset for new file
    this.completeWaitStartTime = 0; // ✅ Reset wait timer
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
    
    // ✅ IMPROVED: Validate index is within expected range
    if (index < 0 || index >= this.metadata.chunks) {
      console.error(`[FileTransferReceiver] CRITICAL: Invalid chunk index ${index}, expected 0-${this.metadata.chunks - 1}`);
      this.onError?.(new Error(`Invalid chunk index ${index}`));
      return;
    }
    
    // ✅ IMPROVED: Check if chunk was already received
    const wasAlreadyReceived = this.receivedChunkBitmap[index];
    if (wasAlreadyReceived) {
      console.warn(`[FileTransferReceiver] Duplicate chunk ${index} received, skipping`);
      return;
    }
    
    // Store chunk and mark as received
    this.receivedChunks.set(index, chunkData);
    this.receivedChunkBitmap[index] = true;
    this.bytesReceived += chunkData.byteLength;
    
    // ✅ NEW: Send acknowledgment to sender
    if (this.onSendControlMessage) {
      this.onSendControlMessage({ type: 'chunk-ack', chunkIndex: index });
    }
    
    // ✅ IMPROVED: Log with clearer formatting for large files
    const receivedCount = this.receivedChunkBitmap.filter(b => b).length;
    const percentage = (receivedCount / this.metadata.chunks * 100).toFixed(2);
    console.log(`[FileTransferReceiver] Chunk ${index}/${this.metadata.chunks - 1} received (${receivedCount}/${this.metadata.chunks} = ${percentage}%), size: ${chunkData.byteLength} bytes`);
    
    const receivedIndices = Array.from(this.receivedChunks.keys()).sort((a, b) => a - b);
    if (receivedCount % 20 === 0 || receivedCount === this.metadata.chunks) {
      // Log progress every 20 chunks for large files
      console.log(`[FileTransferReceiver] Progress: ${receivedIndices.length} chunks stored, bitmap: ${receivedCount}/${this.metadata.chunks}, total size: ${this.bytesReceived} bytes`);
    }
    
    // ✅ NEW: If we already received 'complete' and now have all chunks, complete immediately
    if (this.completeMessageReceived && receivedCount === this.metadata.chunks) {
      console.log('[FileTransferReceiver] All chunks finally received after waiting. Completing now.');
      this.handleComplete();
      return;
    }
    
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

    // ✅ CRITICAL FIX: Build chunks array in correct index order, not in arrival order
    // Chunks may arrive out of order, so we must store them at the correct indices
    const chunks: (ArrayBuffer | null)[] = new Array(this.metadata.chunks).fill(null);
    const missingChunks: number[] = [];
    let totalSize = 0;
    
    for (let i = 0; i < this.metadata.chunks; i++) {
      // Use bitmap to determine if chunk was received
      if (!this.receivedChunkBitmap[i]) {
        missingChunks.push(i);
      } else {
        const chunk = this.receivedChunks.get(i);
        if (chunk) {
          // ✅ Store chunk at its correct index position, not in push order
          chunks[i] = chunk;
          totalSize += chunk.byteLength;
        } else {
          // Chunk was marked as received in bitmap but not in Map - this is a critical error
          console.error(`[FileTransferReceiver] CRITICAL: Chunk ${i} marked received in bitmap but not in Map`);
          missingChunks.push(i);
        }
      }
    }
    
    // ✅ IMPROVED: Handle missing chunks gracefully - WAIT instead of failing immediately
    if (missingChunks.length > 0) {
      // First time receiving 'complete' with missing chunks
      if (this.completeWaitStartTime === 0) {
        this.completeWaitStartTime = Date.now();
        this.completeMessageReceived = true;
        console.log(`[FileTransferReceiver] Received 'complete' but missing ${missingChunks.length} chunks. Waiting for them...`);
      }
      
      const elapsed = Date.now() - this.completeWaitStartTime;
      
      // Check timeout
      if (elapsed > this.RECEIVER_WAIT_TIMEOUT_MS) {
        const missingPercentage = ((missingChunks.length / this.metadata.chunks) * 100).toFixed(2);
        const errorMsg = missingChunks.length === 1
          ? `Missing chunk ${missingChunks[0]} of ${this.metadata.chunks} (${missingPercentage}%)`
          : `Missing ${missingChunks.length} chunks of ${this.metadata.chunks} (${missingPercentage}%): [${missingChunks.slice(0, 10).join(', ')}${missingChunks.length > 10 ? '...' : ''}]`;
        
        console.error(`[FileTransferReceiver] Timeout waiting for missing chunks: ${errorMsg}`);
        this.onError?.(new Error(errorMsg));
        return;
      }
      
      // Still waiting for chunks
      console.log(`[FileTransferReceiver] Still waiting (${elapsed}ms/${this.RECEIVER_WAIT_TIMEOUT_MS}ms). Missing chunks: ${missingChunks.length}/${this.metadata.chunks}. Checking again in 500ms...`);
      
      // Check again after 500ms
      await new Promise(resolve => setTimeout(resolve, 500));
      this.handleComplete();
      return;
    }
    
    // ✅ Filter out nulls and verify all chunks are present
    const finalChunks: ArrayBuffer[] = chunks.filter((c): c is ArrayBuffer => c !== null);
    if (finalChunks.length !== this.metadata.chunks) {
      const errorMsg = `Internal error: Expected ${this.metadata.chunks} chunks but got ${finalChunks.length}`;
      console.error(`[FileTransferReceiver] ${errorMsg}`);
      this.onError?.(new Error(errorMsg));
      return;
    }

    const blob = new Blob(finalChunks, { type: this.metadata.type });
    
    // ✅ NEW: Validate final file size matches expected size
    if (blob.size !== this.metadata.size) {
      const errorMsg = `File size mismatch: received ${blob.size} bytes, expected ${this.metadata.size} bytes`;
      console.error(`[FileTransferReceiver] ${errorMsg}`);
      this.onError?.(new Error(errorMsg));
      return;
    }
    
    // ✅ CRITICAL: Reset wait state to prevent stuck waiting loops
    this.completeMessageReceived = false;
    this.completeWaitStartTime = 0;
    
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
    
    // ✅ Send ack-all message to sender before completing
    this.sendAckAll();
    
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
    this.completeMessageReceived = false; // ✅ Reset
    this.completeWaitStartTime = 0; // ✅ Reset
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