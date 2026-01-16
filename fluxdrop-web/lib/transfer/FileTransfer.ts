// KEY FIXES:
// 1. Batch ACKs to reduce message overhead
// 2. Smarter resume request throttling
// 3. Better tracking of in-flight chunks
// 4. Reduced proactive check aggressiveness

import { encryptAESGCM, sha256, decryptAESGCM } from "../crypto/crypto";

export interface BatchMetadata {
  files: FileMetadata[];
}

export let CHUNK_SIZE = 192 * 1024;

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  chunks: number;
  relativePath?: string;
  fileIndex?: number;
}

export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speed: number;
  timeRemaining: number;
  currentChunk: number;
  totalChunks: number;
  fileIndex?: number;
}

interface ChunkMessage {
  type:
    | "batch-metadata"
    | "metadata"
    | "chunk"
    | "complete"
    | "file-complete-ack"
    | "resume-request"
    | "chunk-ack"
    | "ack-all"
    | "batch-ack"; // ✅ NEW: Batch acknowledgments
  missingChunks?: number[];
  batchMetadata?: BatchMetadata;
  metadata?: FileMetadata;
  chunkIndex?: number;
  chunkIndices?: number[]; // ✅ NEW: For batch acks
  data?: ArrayBuffer;
  iv?: number[];
  hash?: string;
  fileIndex?: number;
}

export class FileTransferSender {
  public onFileComplete?: (fileIndex: number) => void;
  public onUserError?: (message: string) => void;
  public onNetworkStatusChange?: (online: boolean) => void;
  
  private errorLog: string[] = [];
  private _networkOnline: boolean = navigator.onLine;
  private _networkListenerAdded: boolean = false;
  private sessionId: string = "";
  private connectionType: string = "";
  private transferSuccess: boolean = false;
  private minChunkDelayMs: number = 0;
  private chunkBuffer: Array<ArrayBuffer | null> = [];
  private maxBufferedChunks: number = 20; // ✅ INCREASED from 10 to 20
  private acknowledgedChunks: Set<number> = new Set();
  private unackedCountThreshold: number = 200; 
  private bufferTrend: number[] = []; // ✅ NEW: Track last 5 buffer readings
  private baseDelay: number = 0; // ✅ NEW: Adaptive delay component
  private chunkSendTimes: Map<string, number> = new Map(); // ✅ NEW: Track sent times
  private timeoutMonitorInterval: NodeJS.Timeout | null = null; // ✅ NEW: Monitor handle
  private encryptionKey: CryptoKey | null = null;
  private files: File[] = [];
  private _fileIndex = 0;
  private file: File | null = null;
  private chunks: Blob[] = [];
  private currentChunk = 0;
  private startTime = 0;
  private bytesSent = 0;
  private isCancelled = false;
  private chunkRetryCounts: Record<number, number> = {};
  private readonly maxChunkRetries = 3;
  private sentChunkBitmap: boolean[] = [];
  
  private fileTransitionInProgress: boolean = false;
  private activeCheckInterval: NodeJS.Timeout | null = null;
  private fileAckTimeout: NodeJS.Timeout | null = null;
  private readonly FILE_ACK_TIMEOUT_MS = 15000;

  private fileCache: Map<number, {
    file: File;
    metadata: FileMetadata;
    chunkSize: number;
  }> = new Map();
  
  private readonly MAX_CACHED_FILES = 3;
  
  private fileCompletionStatus: Map<number, {
    allChunksSent: boolean;
    allChunksAcked: boolean;
    fileCompleteAckReceived: boolean;
    completionTime: number;
  }> = new Map();

  private chunkResendCounts: Map<string, number> = new Map();
  private readonly MAX_CHUNK_RESENDS = 20; // ✅ Increased from 15
  private lastResendTime: Map<string, number> = new Map();
  
  private chunksInFlight: Set<string> = new Set();

  public onProgress?: (progress: TransferProgress) => void;
  public onComplete?: () => void;
  public onError?: (error: Error) => void;

  constructor(
    private sendData: (data: ArrayBuffer | Uint8Array) => boolean,
    private getBufferedAmount: () => number,
    private getDataChannelState?: () => string
  ) {}

  public get fileIndex() {
    return this._fileIndex;
  }

  public setSessionId(id: string) {
    this.sessionId = id;
  }

  public setMinChunkDelay(ms: number) {
    this.minChunkDelayMs = ms;
  }

  public static setChunkSize(size: number) {
    CHUNK_SIZE = size;
  }

  public enableNetworkStatusListener() {
    if (this._networkListenerAdded) return;
    window.addEventListener("online", this._handleNetworkOnline);
    window.addEventListener("offline", this._handleNetworkOffline);
    this._networkListenerAdded = true;
  }

  private _handleNetworkOnline = () => {
    this._networkOnline = true;
    this.onNetworkStatusChange?.(true);
  };

  private _handleNetworkOffline = () => {
    this._networkOnline = false;
    this.onNetworkStatusChange?.(false);
  };

  setEncryptionKey(key: CryptoKey) {
    this.encryptionKey = key;
  }

  private logError(msg: string) {
    const timestamp = new Date().toLocaleTimeString();
    this.errorLog.push(`[${timestamp}] ${msg}`);
  }

  public getErrorLog(): string[] {
    return [...this.errorLog];
  }

  public handleBatchAck(fileIndex: number, chunkIndices: number[]) {
    if (fileIndex !== this._fileIndex) return;
    
    chunkIndices.forEach(idx => {
      this.acknowledgedChunks.add(idx);
      const key = `${fileIndex}-${idx}`;
      this.chunksInFlight.delete(key);
      this.chunkSendTimes.delete(key); // ✅ NEW: Clean up
    });
    
    console.log(`[FileTransferSender] ✅ Batch ACK: ${chunkIndices.length} chunks for file ${fileIndex}`);
  }

  public handleChunkAck(fileIndex: number, chunkIndex: number) {
    if (fileIndex !== this._fileIndex) return;
    
    this.acknowledgedChunks.add(chunkIndex);
    const key = `${fileIndex}-${chunkIndex}`;
    this.chunksInFlight.delete(key);
    this.chunkSendTimes.delete(key); // ✅ NEW: Clean up
  }

  public handleAckAll(fileIndex: number) {
    if (fileIndex !== this._fileIndex) return;
    if (this.chunks) {
      for (let i = 0; i < this.chunks.length; i++) {
        this.acknowledgedChunks.add(i);
        const key = `${fileIndex}-${i}`;
        this.chunksInFlight.delete(key);
        this.chunkSendTimes.delete(key); // ✅ NEW: Clean up
      }
    }
  }

  public handleMessage(data: ArrayBuffer) {
    const view = new DataView(data);
    const headerLength = view.getUint32(0, true);
    const headerBytes = new Uint8Array(data, 4, headerLength);
    const decoder = new TextDecoder();
    const headerJson = decoder.decode(headerBytes);
    const header = JSON.parse(headerJson);

    if (header.type === "chunk-ack") {
      this.handleChunkAck(header.fileIndex ?? this._fileIndex, header.chunkIndex);
    } else if (header.type === "batch-ack") {
      this.handleBatchAck(header.fileIndex ?? this._fileIndex, header.chunkIndices || []);
    } else if (header.type === "file-complete-ack") {
      this.handleFileCompleteAck(header.fileIndex ?? this._fileIndex);
    } else if (header.type === "resume-request") {
      this.handleResumeRequest(header.fileIndex ?? this._fileIndex, header.missingChunks || []);
    } else if (header.type === "ack-all") {
      this.handleAckAll(header.fileIndex ?? this._fileIndex);
    }
  }

  private handleFileCompleteAck(fileIndex: number) {
    console.log(`[FileTransferSender] ✅ Received file-complete-ack for file ${fileIndex}`);
    
    const status = this.fileCompletionStatus.get(fileIndex);
    if (status) {
      status.fileCompleteAckReceived = true;
    }

    if (fileIndex === this._fileIndex) {
      if (this.activeCheckInterval) {
        clearInterval(this.activeCheckInterval);
        this.activeCheckInterval = null;
      }
      if (this.fileAckTimeout) {
        clearTimeout(this.fileAckTimeout);
        this.fileAckTimeout = null;
      }
      
      if (!this.fileTransitionInProgress) {
        this.transitionToNextFile();
      }
    }

    this.fileCache.delete(fileIndex);
  }

  private transitionToNextFile() {
    if (this.fileTransitionInProgress) return;
    this.fileTransitionInProgress = true;

    console.log(`[FileTransferSender] Transitioning from file ${this._fileIndex}`);
    
    const status = this.fileCompletionStatus.get(this._fileIndex);
    if (status) status.allChunksAcked = true;

    this._fileIndex++;
    this.startNextFile().finally(() => {
      this.fileTransitionInProgress = false;
    });
  }

  public async handleResumeRequest(targetFileIndex: number, missingChunks: number[]) {
    console.log(`[FileTransferSender] 📥 Resume request for file ${targetFileIndex}, chunks: ${missingChunks.length}`);

    if (targetFileIndex === this._fileIndex) {
      if (!this.chunks || !this.file) {
        console.error(`[FileTransferSender] Current file not loaded`);
        return;
      }
      await this.resendChunksFromBlobs(targetFileIndex, missingChunks, this.chunks);
      return;
    }

    if (targetFileIndex < this._fileIndex) {
      const cached = this.fileCache.get(targetFileIndex);
      if (!cached) {
        console.error(`[FileTransferSender] ❌ File ${targetFileIndex} not in cache`);
        this.sendMessage({ type: "complete", fileIndex: targetFileIndex });
        return;
      }

      try {
        const testChunk = cached.file.slice(0, Math.min(1024, cached.file.size));
        await testChunk.arrayBuffer();
      } catch (e) {
        console.error(`[FileTransferSender] ❌ Cache corrupted for file ${targetFileIndex}`);
        this.fileCache.delete(targetFileIndex);
        this.sendMessage({ type: "complete", fileIndex: targetFileIndex });
        return;
      }

      console.log(`[FileTransferSender] ✅ Found file ${targetFileIndex} in cache, resending ${missingChunks.length} chunks`);
      await this.resendChunksFromFile(targetFileIndex, missingChunks, cached.file, cached.chunkSize);
      return;
    }

    console.error(`[FileTransferSender] Invalid resume request for future file ${targetFileIndex}`);
  }

  private async resendChunksFromBlobs(fileIndex: number, missingChunks: number[], chunks: Blob[]) {
    const chunksToResend = await this.filterChunksToResend(fileIndex, missingChunks);
    if (chunksToResend.length === 0) return;

    for (const idx of chunksToResend) {
      if (idx >= 0 && idx < chunks.length) {
        const chunk = chunks[idx];
        await this.encryptAndSendChunk(fileIndex, idx, chunk);
      }
    }
  }

  private async resendChunksFromFile(fileIndex: number, missingChunks: number[], file: File, chunkSize: number) {
    const chunksToResend = await this.filterChunksToResend(fileIndex, missingChunks);
    if (chunksToResend.length === 0) return;

    for (const idx of chunksToResend) {
      const start = idx * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      
      if (start < file.size) {
        const chunk = file.slice(start, end);
        await this.encryptAndSendChunk(fileIndex, idx, chunk);
      }
    }
  }

  private async filterChunksToResend(fileIndex: number, missingChunks: number[]): Promise<number[]> {
    const now = Date.now();
    const chunksToResend: number[] = [];
    const failedChunks: number[] = [];
    
    for (const idx of missingChunks) {
      const key = `${fileIndex}-${idx}`;
      
      if (fileIndex === this._fileIndex && this.acknowledgedChunks.has(idx)) {
        console.log(`[FileTransferSender] Skipping chunk ${idx} - already ACKed`);
        continue;
      }
      
      if (this.chunksInFlight.has(key)) {
        console.log(`[FileTransferSender] Skipping chunk ${idx} - already in flight`);
        continue;
      }

      const resendCount = this.chunkResendCounts.get(key) || 0;
      if (resendCount >= this.MAX_CHUNK_RESENDS) {
        failedChunks.push(idx);
        continue;
      }
      
      const lastSent = this.lastResendTime.get(key) || 0;
      const backoffDelay = Math.min(5000, 200 * Math.pow(1.5, resendCount)) + Math.random() * 100;
      const timeSinceLastSend = now - lastSent;
      
      if (timeSinceLastSend < backoffDelay) {
        console.log(`[FileTransferSender] Throttling chunk ${idx} - sent ${timeSinceLastSend}ms ago, need ${backoffDelay}ms`);
        continue;
      }
      
      this.chunkResendCounts.set(key, resendCount + 1);
      this.lastResendTime.set(key, now);
      this.chunksInFlight.add(key); 
      chunksToResend.push(idx);
    }
    
    if (failedChunks.length > 0) {
      console.error(`[FileTransferSender] ❌ ${failedChunks.length} chunks exceeded retry limit`);
      this.onError?.(new Error(`Transfer failed: ${failedChunks.length} chunks could not be sent after ${this.MAX_CHUNK_RESENDS} retries`));
      this.cancel();
      return [];
    }

    const buffered = this.getBufferedAmount();
    if (buffered > CHUNK_SIZE * 20) {
      console.warn(`[FileTransferSender] High buffered amount (${buffered} bytes), delaying resends`);
      setTimeout(() => this.handleResumeRequest(fileIndex, chunksToResend), 500);
      return [];
    }

    console.log(`[FileTransferSender] 📤 Resending ${chunksToResend.length} chunks for file ${fileIndex}`);
    return chunksToResend;
  }

  private async encryptAndSendChunk(fileIndex: number, chunkIndex: number, chunk: Blob) {
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
      type: "chunk",
      chunkIndex,
      data: arrayBuffer,
      fileIndex,
      ...(iv ? { iv: Array.from(iv) } : {}),
      hash: hashB64,
    });
    
    const resendDelay = this.getBufferedAmount() > CHUNK_SIZE ? 100 : 30;
    await new Promise(resolve => setTimeout(resolve, resendDelay));
  }

  public async startBatchTransfer(files: File[]) {
    this.files = files;
    this._fileIndex = 0;

    const batchMetadata: BatchMetadata = {
      files: files.map((f, idx) => ({
        name: f.name,
        size: f.size,
        type: f.type,
        chunks: Math.ceil(f.size / CHUNK_SIZE),
        relativePath: (f as any).webkitRelativePath || f.name,
        fileIndex: idx,
      })),
    };

    this.sendMessage({ type: "batch-metadata", batchMetadata });
    await new Promise(resolve => setTimeout(resolve, 100));
    await this.startNextFile();
  }

  private async startNextFile() {
    if (typeof (window as any).currentConnectionType === "string") {
      this.connectionType = (window as any).currentConnectionType;
    }

    if (this._fileIndex >= this.files.length) {
      console.log(`[FileTransferSender] All files complete (${this.files.length} total)`);
      if (this.timeoutMonitorInterval) {
        clearInterval(this.timeoutMonitorInterval);
        this.timeoutMonitorInterval = null;
      }
      this.onComplete?.();
      return;
    }

    const prevFileIndex = this._fileIndex - 1;
    if (prevFileIndex >= 0 && this.file) {
      console.log(`[FileTransferSender] 💾 Caching file ${prevFileIndex} (File reference only)`);
      this.fileCache.set(prevFileIndex, {
        file: this.file,
        metadata: {
          name: this.file.name,
          size: this.file.size,
          type: this.file.type,
          chunks: this.chunks.length,
          relativePath: (this.file as any).webkitRelativePath || this.file.name,
          fileIndex: prevFileIndex,
        },
        chunkSize: CHUNK_SIZE
      });

      if (this.fileCache.size > this.MAX_CACHED_FILES) {
        const oldestKey = Math.min(...this.fileCache.keys());
        console.log(`[FileTransferSender] 🗑️ Evicting file ${oldestKey} from cache`);
        this.fileCache.delete(oldestKey);
      }
    }

    const file = this.files[this._fileIndex];
    this.file = file;
    this.chunks = this.createChunks(file);
    this.currentChunk = 0;
    this.bytesSent = 0;
    this.startTime = Date.now();
    this.sentChunkBitmap = new Array(this.chunks.length).fill(false);
    this.acknowledgedChunks.clear();
    this.chunkRetryCounts = {};
    this.chunkResendCounts.clear();
    this.lastResendTime.clear();
    this.chunksInFlight.clear(); 
    this.chunkSendTimes.clear(); // ✅ NEW
    this.bufferTrend = []; // ✅ NEW
    this.baseDelay = 0; // ✅ NEW
    this.fileTransitionInProgress = false;

    if (!this.timeoutMonitorInterval) {
      this.startChunkTimeoutMonitor();
    }

    this.fileCompletionStatus.set(this._fileIndex, {
      allChunksSent: false,
      allChunksAcked: false,
      fileCompleteAckReceived: false,
      completionTime: 0,
    });

    this.chunkBuffer = new Array(this.chunks.length).fill(null);
    for (let i = 0; i < Math.min(this.chunks.length, this.maxBufferedChunks); i++) {
      this.chunks[i].arrayBuffer().then((buf) => {
        this.chunkBuffer[i] = buf;
      });
    }

    const metadata: FileMetadata = {
      name: file.name,
      size: file.size,
      type: file.type,
      chunks: this.chunks.length,
      relativePath: (file as any).webkitRelativePath || file.name,
      fileIndex: this._fileIndex,
    };

    this.sendMessage({ type: "metadata", metadata });
    await this.sendNextChunk();
  }

  private createChunks(file: File): Blob[] {
    const chunks: Blob[] = [];
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const chunk = file.slice(offset, end);
      chunks.push(chunk);
      offset = end;
    }
    return chunks;
  }

  private async sendNextChunk() {
    if (this.isCancelled) return;

    if (this.currentChunk >= this.chunks.length) {
      console.log(`[FileTransferSender] All chunks sent for file ${this._fileIndex}`);

      const status = this.fileCompletionStatus.get(this._fileIndex);
      if (status) {
        status.allChunksSent = true;
        status.completionTime = Date.now();
      }

      this.onFileComplete?.(this._fileIndex);
      this.sendMessage({ type: "complete", fileIndex: this._fileIndex });

      this.activeCheckInterval = setInterval(() => {
        const ackedCount = this.acknowledgedChunks.size;
        const totalChunks = this.chunks.length;

        if (ackedCount >= totalChunks) {
          console.log(`[FileTransferSender] ✅ All chunks for file ${this._fileIndex} acknowledged!`);
          
          if (this.activeCheckInterval) {
            clearInterval(this.activeCheckInterval);
            this.activeCheckInterval = null;
          }
          if (this.fileAckTimeout) {
            clearTimeout(this.fileAckTimeout);
            this.fileAckTimeout = null;
          }
          
          this.transitionToNextFile();
        }
      }, 500);

      this.fileAckTimeout = setTimeout(() => {
        if (this.fileTransitionInProgress) return;
        
        if (this.activeCheckInterval) {
          clearInterval(this.activeCheckInterval);
          this.activeCheckInterval = null;
        }
        if (this.fileAckTimeout) {
          clearTimeout(this.fileAckTimeout);
          this.fileAckTimeout = null;
        }
        
        console.warn(`[FileTransferSender] ⚠️ Timeout for file ${this._fileIndex}, proceeding`);
        this.transitionToNextFile();
      }, this.getFileTimeout(this.file!.size));

      return;
    }

    const retryCount = this.chunkRetryCounts[this.currentChunk] || 0;
    if (retryCount >= this.maxChunkRetries) {
      this.onError?.(new Error(`Max retries reached for chunk ${this.currentChunk}`));
      this.isCancelled = true;
      return;
    }

    const sentButUnackedCount = this.currentChunk - this.acknowledgedChunks.size;
    if (sentButUnackedCount > this.unackedCountThreshold) {
      console.warn(`[FileTransferSender] ⏸️ Pausing: ${sentButUnackedCount} unacked chunks (threshold: ${this.unackedCountThreshold})`);
      setTimeout(() => this.sendNextChunk(), 200);
      return;
    }

    const buffered = this.getBufferedAmount();
    if (buffered > CHUNK_SIZE * 30) {
      setTimeout(() => this.sendNextChunk(), 50);
      return;
    }

    let arrayBuffer: ArrayBuffer;
    if (this.chunkBuffer[this.currentChunk]) {
      arrayBuffer = this.chunkBuffer[this.currentChunk]!;
    } else if (this.chunks[this.currentChunk]) {
      arrayBuffer = await this.chunks[this.currentChunk].arrayBuffer();
    } else {
      console.error(`[FileTransferSender] Chunk missing at index ${this.currentChunk}`);
      return;
    }

    if (this.currentChunk > 0) {
      this.chunkBuffer[this.currentChunk - 1] = null;
    }

    const hashBuffer = await sha256(arrayBuffer);
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
    let iv: Uint8Array | undefined = undefined;

    if (this.encryptionKey) {
      const ivRaw = window.crypto.getRandomValues(new Uint8Array(12));
      iv = new Uint8Array(ivRaw.buffer.slice(0));
      arrayBuffer = await encryptAESGCM(this.encryptionKey, arrayBuffer, iv as BufferSource);
    }

    this.sendMessage({
      type: "chunk",
      chunkIndex: this.currentChunk,
      fileIndex: this._fileIndex,
      data: arrayBuffer,
      ...(iv ? { iv: Array.from(iv) } : {}),
      hash: hashB64,
    });

    const key = `${this._fileIndex}-${this.currentChunk}`;
    this.chunkSendTimes.set(key, Date.now()); // ✅ NEW: Track timing

    this.bytesSent += arrayBuffer.byteLength;
    this.sentChunkBitmap[this.currentChunk] = true;
    
    // Rolling buffer Load: load ahead by maxBufferedChunks
    const nextToLoad = this.currentChunk + this.maxBufferedChunks;
    if (nextToLoad < this.chunks.length && !this.chunkBuffer[nextToLoad]) {
      this.chunks[nextToLoad].arrayBuffer().then((buf) => {
        this.chunkBuffer[nextToLoad] = buf;
      }).catch(e => console.error(`[Sender] Buffer load failed for chunk ${nextToLoad}`, e));
    }

    this.currentChunk++;
    this.updateProgress();

    // 📈 Adaptive Speed Control
    const currentBuffered = this.getBufferedAmount();
    this.bufferTrend.push(currentBuffered);
    if (this.bufferTrend.length > 5) this.bufferTrend.shift();

    if (this.bufferTrend.length >= 3) {
      const avgRecent = this.bufferTrend.slice(-2).reduce((a, b) => a + b) / 2;
      const avgOlder = this.bufferTrend.slice(0, -2).reduce((a, b) => a + b) / (this.bufferTrend.length - 2);
      
      if (avgRecent > avgOlder * 1.1) {
        this.baseDelay = Math.min(this.baseDelay + 5, 50);
      } else if (avgRecent < avgOlder * 0.9) {
        this.baseDelay = Math.max(this.baseDelay - 2, 0);
      }
    }

    const adaptiveDelay = this.minChunkDelayMs + this.baseDelay;
    setTimeout(() => this.sendNextChunk(), adaptiveDelay);
  }

  private updateProgress() {
    if (!this.file) return;
    const elapsed = (Date.now() - this.startTime) / 1000;
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
      totalChunks: this.chunks.length,
      fileIndex: this._fileIndex,
    };
    this.onProgress?.(progress);
  }

  private sendMessage(message: ChunkMessage) {
    if (this.getDataChannelState && this.getDataChannelState() !== "open") {
      setTimeout(() => this.sendNextChunk(), 500);
      return;
    }

    const encoder = new TextEncoder();
    const headerObj: any = {
      type: message.type,
      metadata: message.metadata,
      chunkIndex: message.chunkIndex,
      chunkIndices: message.chunkIndices, 
      fileIndex: message.fileIndex,
    };
    if (message.iv) headerObj.iv = message.iv;
    if (message.hash) headerObj.hash = message.hash;
    if (message.batchMetadata) headerObj.batchMetadata = message.batchMetadata;

    const json = JSON.stringify(headerObj);
    const header = encoder.encode(json);
    const headerLengthBuffer = new ArrayBuffer(4);
    const headerLengthView = new DataView(headerLengthBuffer);
    headerLengthView.setUint32(0, header.length, true);

    if (message.data) {
      const dataBytes = new Uint8Array(message.data);
      const totalSize = 4 + header.length + dataBytes.byteLength;
      const combined = new Uint8Array(totalSize);
      combined.set(new Uint8Array(headerLengthBuffer), 0);
      combined.set(header, 4);
      combined.set(dataBytes, 4 + header.length);
      this.sendData(combined);
    } else {
      const combined = new Uint8Array(4 + header.length);
      combined.set(new Uint8Array(headerLengthBuffer), 0);
      combined.set(header, 4);
      this.sendData(combined);
    }
  }

  cancel() {
    this.isCancelled = true;
    if (this.activeCheckInterval) clearInterval(this.activeCheckInterval);
    if (this.fileAckTimeout) clearTimeout(this.fileAckTimeout);
    if (this.timeoutMonitorInterval) clearInterval(this.timeoutMonitorInterval);
  }

  private getFileTimeout(fileSize: number): number {
    const baseSec = 60;
    const perMB = 1;
    const maxSec = 300;
    const fileMB = fileSize / (1024 * 1024);
    return Math.min(baseSec + fileMB * perMB, maxSec) * 1000;
  }

  private startChunkTimeoutMonitor() {
    this.timeoutMonitorInterval = setInterval(() => {
      if (this.isCancelled) return;
      const now = Date.now();
      const timedOut: number[] = [];
      
      this.chunkSendTimes.forEach((time, key) => {
        if (now - time > 5000) { 
          const [fileIdx, chunkIdx] = key.split('-').map(Number);
          if (fileIdx === this._fileIndex && !this.acknowledgedChunks.has(chunkIdx)) {
            timedOut.push(chunkIdx);
            this.chunkSendTimes.delete(key);
          }
        }
      });
      
      if (timedOut.length > 0) {
        console.warn(`[FileTransferSender] ⏱️ ${timedOut.length} chunks timed out, triggering resend`);
        this.handleResumeRequest(this._fileIndex, timedOut);
      }
    }, 2000);
  }
}

// ============================================
// RECEIVER WITH IMPROVED ACK BATCHING
// ============================================

interface FileReceiverState {
  metadata: FileMetadata;
  receivedChunks: Map<number, ArrayBuffer>;
  receivedChunkBitmap: boolean[];
  bytesReceived: number;
  startTime: number;
  completeMessageReceived: boolean;
  completeWaitStartTime: number;
  completeFileInProgress: boolean;
  lastMissingChunkRequest: number;
  highestChunkReceived: number;
  pendingAcks: Set<number>; 
  lastAckBatchSent: number; 
}

export class FileTransferReceiver {
  private errorLog: string[] = [];
  private decryptionKey: CryptoKey | null = null;
  private sendDataCallback?: (data: ArrayBuffer | Uint8Array) => boolean;
  
  private batchMetadata: FileMetadata[] = [];
  private fileStates: Map<number, FileReceiverState> = new Map();
  
  private lastProactiveCheckTime: Map<number, number> = new Map();
  private readonly PROACTIVE_CHECK_INTERVAL_MS = 12000; // ✅ INCREASED from 8s to 12s
 
  private fileResumeRetryCount: Map<number, number> = new Map();
  private readonly MAX_FILE_RESUME_RETRIES = 10;
  
  private lastResumeRequestTime: Map<number, number> = new Map();
  private readonly MIN_RESUME_REQUEST_INTERVAL_MS = 5000; // ✅ INCREASED from 3s to 5s
  
  public onMetadata?: (metadata: FileMetadata) => void;
  public onProgress?: (progress: TransferProgress) => void;
  public onComplete?: (file: Blob, fileIndex: number) => void;
  public onError?: (error: Error) => void;
  public onBatchMetadata?: (batchMetadata: BatchMetadata) => void;

  private logError(msg: string) {
    const timestamp = new Date().toLocaleTimeString();
    this.errorLog.push(`[${timestamp}] ${msg}`);
  }

  public getErrorLog(): string[] {
    return [...this.errorLog];
  }

  setDecryptionKey(key: CryptoKey) {
    this.decryptionKey = key;
  }

  public setSendData(callback: (data: ArrayBuffer | Uint8Array) => boolean) {
    this.sendDataCallback = callback;
  }

  private sendControlMessage(message: ChunkMessage) {
    if (!this.sendDataCallback) return;
    const encoder = new TextEncoder();
    const headerObj: any = { type: message.type };
    if (message.chunkIndex !== undefined) headerObj.chunkIndex = message.chunkIndex;
    if (message.chunkIndices !== undefined) headerObj.chunkIndices = message.chunkIndices;
    if (message.missingChunks) headerObj.missingChunks = message.missingChunks;
    if (message.fileIndex !== undefined) headerObj.fileIndex = message.fileIndex;
    const json = JSON.stringify(headerObj);
    const header = encoder.encode(json);
    const headerLengthBuffer = new ArrayBuffer(4);
    const headerLengthView = new DataView(headerLengthBuffer);
    headerLengthView.setUint32(0, header.length, true);
    const combined = new Uint8Array(4 + header.length);
    combined.set(new Uint8Array(headerLengthBuffer), 0);
    combined.set(header, 4);
    this.sendDataCallback(combined);
  }

  private sendBatchAck(fileIndex: number, chunkIndices: number[]) {
    if (chunkIndices.length === 0) return;
    console.log(`[FileTransferReceiver] 📤 Sending batch ACK: ${chunkIndices.length} chunks`);
    this.sendControlMessage({ type: "batch-ack", fileIndex, chunkIndices });
  }

  private sendAckAll(fileIndex: number) {
    this.sendControlMessage({ type: "ack-all", fileIndex });
  }

  async handleMessage(data: ArrayBuffer) {
    const message = this.parseMessage(data);
    switch (message.type) {
      case "batch-metadata":
        this.handleBatchMetadata(message.batchMetadata!);
        break;
      case "metadata":
        this.handleMetadata(message.metadata!);
        break;
      case "chunk":
        await this.handleChunk(
          message.fileIndex ?? 0,
          message.chunkIndex!,
          message.data!,
          message.iv,
          message.hash
        );
        break;
      case "complete":
        await this.handleComplete(message.fileIndex ?? 0);
        break;
    }
  }

  private parseMessage(data: ArrayBuffer): ChunkMessage {
    const view = new DataView(data);
    const headerLength = view.getUint32(0, true);
    const headerBytes = new Uint8Array(data, 4, headerLength);
    const decoder = new TextDecoder();
    const headerJson = decoder.decode(headerBytes);
    const header = JSON.parse(headerJson);
    if (header.type === "chunk") {
      const chunkData = data.slice(4 + headerLength);
      return { ...header, data: chunkData };
    }
    return { ...header };
  }

  private handleBatchMetadata(batchMetadata: BatchMetadata) {
    this.batchMetadata = batchMetadata.files.map((f, idx) => ({
      ...f,
      fileIndex: f.fileIndex ?? idx,
    }));
    this.onBatchMetadata?.({ files: this.batchMetadata });
  }

  private handleMetadata(metadata: FileMetadata) {
    const fileIndex = metadata.fileIndex ?? 0;
    this.fileStates.set(fileIndex, {
      metadata,
      receivedChunks: new Map(),
      receivedChunkBitmap: new Array(metadata.chunks).fill(false),
      bytesReceived: 0,
      startTime: Date.now(),
      completeMessageReceived: false,
      completeWaitStartTime: 0,
      completeFileInProgress: false,
      lastMissingChunkRequest: 0,
      highestChunkReceived: -1,
      pendingAcks: new Set(), 
      lastAckBatchSent: 0, 
    });
    
    // ✅ NEW: Start periodic ACK flush watchdog to prevent deadlock
    const ackFlushInterval = setInterval(() => {
      const state = this.fileStates.get(fileIndex);
      if (!state) {
        clearInterval(ackFlushInterval);
        return;
      }
      
      if (state.pendingAcks.size > 0) {
        console.log(`[FileTransferReceiver] ⏰ Watchdog forcing ACK flush: ${state.pendingAcks.size} pending`);
        this.flushAckBatch(fileIndex, state);
      }
    }, 500); // ✅ REDUCED from 1s to 500ms
    
    this.onMetadata?.(metadata);
  }

  private async handleChunk(fileIndex: number, chunkIndex: number, data: ArrayBuffer, iv?: number[], hash?: string) {
    const state = this.fileStates.get(fileIndex);
    if (!state) return;

    if (state.receivedChunkBitmap[chunkIndex]) {
      state.pendingAcks.add(chunkIndex);
      this.flushAckBatch(fileIndex, state);
      return;
    }

    let chunkData: ArrayBuffer;
    if (this.decryptionKey && iv) {
      try {
        chunkData = await decryptAESGCM(this.decryptionKey, data, new Uint8Array(iv));
      } catch (e) {
        console.error(`[FileTransferReceiver] Decryption failed for chunk ${chunkIndex}`);
        setTimeout(() => {
          this.sendControlMessage({ type: "resume-request", missingChunks: [chunkIndex], fileIndex });
        }, 1000);
        return;
      }
    } else {
      chunkData = data;
    }

    if (hash) {
      const hashBuffer = await sha256(chunkData);
      const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
      if (hashB64 !== hash) {
        console.error(`[FileTransferReceiver] Hash mismatch for chunk ${chunkIndex}`);
        setTimeout(() => {
          this.sendControlMessage({ type: "resume-request", missingChunks: [chunkIndex], fileIndex });
        }, 1000);
        return;
      }
    }

    state.receivedChunks.set(chunkIndex, chunkData);
    state.receivedChunkBitmap[chunkIndex] = true;
    state.bytesReceived += chunkData.byteLength;
    state.highestChunkReceived = Math.max(state.highestChunkReceived, chunkIndex);

    state.pendingAcks.add(chunkIndex);
    
    const now = Date.now();
    const immediateFlush = chunkIndex % 100 === 0 && chunkIndex > 0;
    
    const timeSinceLastAck = now - state.lastAckBatchSent;
    const shouldFlush = 
      immediateFlush ||
      state.pendingAcks.size >= 25 || 
      (timeSinceLastAck > 500 && state.pendingAcks.size > 0) || // ✅ REDUCED from 200ms to 500ms for more batching
      (timeSinceLastAck > 1000); // ✅ FORCE flush after 1s no matter what
    
    if (shouldFlush) {
      this.flushAckBatch(fileIndex, state);
    }

    this.updateProgress(fileIndex, state);

    if (state.receivedChunkBitmap.every(Boolean)) {
      console.log(`[FileTransferReceiver] ✅ All chunks received for file ${fileIndex}`);
      
      this.flushAckBatch(fileIndex, state);
      this.sendAckAll(fileIndex);
      await this.completeFile(fileIndex, state);
    } else {
      this.checkForMissingChunks(fileIndex, state);
    }
  }

  private flushAckBatch(fileIndex: number, state: FileReceiverState) {
    if (state.pendingAcks.size === 0) return;
    
    const chunkIndices = Array.from(state.pendingAcks);
    this.sendBatchAck(fileIndex, chunkIndices);
    
    state.pendingAcks.clear();
    state.lastAckBatchSent = Date.now();
  }

  private checkForMissingChunks(fileIndex: number, state: FileReceiverState) {
    const now = Date.now();
    
    const lastCheck = this.lastProactiveCheckTime.get(fileIndex) || 0;
    if (now - lastCheck < this.PROACTIVE_CHECK_INTERVAL_MS) {
      return;
    }
    
    const lastResume = this.lastResumeRequestTime.get(fileIndex) || 0;
    if (now - lastResume < this.MIN_RESUME_REQUEST_INTERVAL_MS) {
      return;
    }
    
    this.lastProactiveCheckTime.set(fileIndex, now);
    
    const receivedCount = state.receivedChunkBitmap.filter(Boolean).length;
    const totalChunks = state.metadata.chunks;
    const highestReceived = state.highestChunkReceived;
    
    // ✅ ONLY check recent window (last 50 chunks)
    const windowStart = Math.max(0, highestReceived - 50);
    const windowEnd = Math.min(highestReceived + 20, totalChunks - 1);
    const expectedByNow = Math.min(highestReceived + 100, totalChunks);
    
    if (receivedCount < expectedByNow * 0.95) {
      const missingChunks: number[] = [];
      
      for (let i = windowStart; i <= windowEnd; i++) {
        if (!state.receivedChunkBitmap[i]) {
          missingChunks.push(i);
        }
      }
      
      if (missingChunks.length > 0 && missingChunks.length < totalChunks * 0.5) {
        console.warn(`[FileTransferReceiver] 🔍 Detected ${missingChunks.length} missing chunks (received ${receivedCount}/${totalChunks})`);
        
        const chunksToRequest = missingChunks.slice(0, 30);
        this.sendControlMessage({
          type: "resume-request",
          missingChunks: chunksToRequest,
          fileIndex
        });
        
        this.lastResumeRequestTime.set(fileIndex, now);
      }
    }
  }

  private updateProgress(fileIndex: number, state: FileReceiverState) {
    const elapsed = (Date.now() - state.startTime) / 1000;
    const speed = elapsed > 0 ? state.bytesReceived / elapsed : 0;
    const remaining = state.metadata.size - state.bytesReceived;
    const timeRemaining = speed > 0 ? remaining / speed : 0;
    const progress: TransferProgress = {
      bytesTransferred: state.bytesReceived,
      totalBytes: state.metadata.size,
      percentage: (state.bytesReceived / state.metadata.size) * 100,
      speed,
      timeRemaining,
      currentChunk: state.receivedChunks.size,
      totalChunks: state.metadata.chunks,
      fileIndex,
    };
    this.onProgress?.(progress);
  }

  private async handleComplete(fileIndex: number) {
    const state = this.fileStates.get(fileIndex);
    if (!state) return;

    console.log(`[FileTransferReceiver] 📨 Received complete message for file ${fileIndex}`);
    state.completeMessageReceived = true;

    this.flushAckBatch(fileIndex, state);

    if (state.receivedChunkBitmap.every(Boolean)) {
      console.log(`[FileTransferReceiver] ✅ All chunks present, completing file ${fileIndex}`);
      await this.completeFile(fileIndex, state);
      return;
    }

    const retryCount = this.fileResumeRetryCount.get(fileIndex) || 0;

    if (retryCount >= this.MAX_FILE_RESUME_RETRIES) {
      console.error(`[FileTransferReceiver] ❌ Max retries reached for file ${fileIndex}`);
      
      const receivedCount = state.receivedChunkBitmap.filter(Boolean).length;
      const receivedPercent = (receivedCount / state.metadata.chunks) * 100;
      
      this.onError?.(new Error(`Transfer incomplete: only received ${receivedPercent.toFixed(1)}% of file ${state.metadata.name}`));
      this.fileStates.delete(fileIndex);
      return;
    }

    this.fileResumeRetryCount.set(fileIndex, retryCount + 1);

    if (state.completeWaitStartTime === 0) {
      state.completeWaitStartTime = Date.now();
    }
    
    const elapsed = Date.now() - state.completeWaitStartTime;
    const dynamicTimeout = 60000 + (state.metadata.size / (1024 * 1024) * 1000);
    const timeout = Math.min(dynamicTimeout, 300000);

    if (elapsed > timeout) {
      this.onError?.(new Error(`Transfer timeout for file ${state.metadata.name}`));
      this.fileStates.delete(fileIndex);
      return;
    }

    const missingChunks: number[] = [];
    for (let i = 0; i < state.metadata.chunks; i++) {
      if (!state.receivedChunkBitmap[i]) {
        missingChunks.push(i);
      }
    }

    if (missingChunks.length > 0) {
      console.log(`[FileTransferReceiver] 📥 Requesting ${missingChunks.length} missing chunks (retry ${retryCount})`);
      
      const chunksToRequest = missingChunks.slice(0, 30);
      this.sendControlMessage({ 
        type: "resume-request", 
        missingChunks: chunksToRequest, 
        fileIndex 
      });
      
      this.lastResumeRequestTime.set(fileIndex, Date.now());
      
      const nextCheckDelay = Math.min(2000 * Math.pow(1.5, retryCount), 10000);
      setTimeout(() => this.handleComplete(fileIndex), nextCheckDelay);
    } else {
      console.warn(`[FileTransferReceiver] ⚠️ No missing chunks found but file not complete, retrying...`);
      setTimeout(() => this.handleComplete(fileIndex), 1000);
    }
  }

  private async completeFile(fileIndex: number, state: FileReceiverState) {
    if (state.completeFileInProgress) return;
    state.completeFileInProgress = true;

    this.flushAckBatch(fileIndex, state);

    // Assemble chunks
    const chunks: ArrayBuffer[] = [];
    for (let i = 0; i < state.metadata.chunks; i++) {
      const chunk = state.receivedChunks.get(i);
      if (!chunk) {
        console.error(`[FileTransferReceiver] ❌ Missing chunk ${i} during completion`);
        state.completeFileInProgress = false;
        
        // Request missing chunk specifically
        this.sendControlMessage({ 
          type: "resume-request", 
          missingChunks: [i], 
          fileIndex 
        });
        return;
      }
      chunks.push(chunk);
    }

    const blob = new Blob(chunks, { type: state.metadata.type });

    // Size verification
    if (blob.size !== state.metadata.size) {
      console.error(`[FileTransferReceiver] ❌ Size mismatch: expected ${state.metadata.size}, got ${blob.size}`);
      this.onError?.(new Error(`Size mismatch for ${state.metadata.name}`));
      state.completeFileInProgress = false;
      return;
    }

    console.log(`[FileTransferReceiver] ✅ File ${fileIndex} complete: ${state.metadata.name} (${blob.size} bytes)`);

    // CRITICAL: Send ACK AFTER blob is ready
    this.sendControlMessage({ type: "file-complete-ack", fileIndex });
    
    // Small delay to ensure ACK is sent before callback
    await new Promise(resolve => setTimeout(resolve, 100));
    
    this.onComplete?.(blob, fileIndex);
    
    // Clean up
    state.receivedChunks.clear();
    this.fileStates.delete(fileIndex);
  }

  reset() {
    this.batchMetadata = [];
    this.fileStates.clear();
    this.lastProactiveCheckTime.clear();
    this.fileResumeRetryCount.clear();
    this.lastResumeRequestTime.clear();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

export function formatSpeed(bytesPerSecond: number): string {
  return formatBytes(bytesPerSecond) + "/s";
}

export function formatTime(seconds: number): string { 
  if (seconds < 60) return Math.round(seconds) + "s"; 
  const minutes = Math.floor(seconds / 60); 
  const secs = Math.round(seconds % 60); 
  return `${minutes}m ${secs}s`; 
}
