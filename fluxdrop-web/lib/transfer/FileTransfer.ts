import { encryptAESGCM, sha256, decryptAESGCM } from "../crypto/crypto";

export interface BatchMetadata {
  files: FileMetadata[];
}

export let CHUNK_SIZE = 192 * 1024; // Default 192KB

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  chunks: number;
  relativePath?: string;
  fileIndex?: number; // ✅ ADD: Track file order explicitly
}


// 1. Update TransferProgress interface to include fileIndex
export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speed: number;
  timeRemaining: number;
  currentChunk: number;
  totalChunks: number;
  fileIndex?: number; // ✅ ADD: Track which file this progress is for
}

interface ChunkMessage {
  type:
    | "batch-metadata"
    | "metadata"
    | "chunk"
    | "complete"
    | "resume-request"
    | "chunk-ack"
    | "ack-all";
  missingChunks?: number[];
  batchMetadata?: BatchMetadata;
  metadata?: FileMetadata;
  chunkIndex?: number;
  data?: ArrayBuffer;
  iv?: number[];
  hash?: string;
  fileIndex?: number; // ✅ ADD: Include file index in messages
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
  private static p2pSuccessCount: number = 0;
  private static relaySuccessCount: number = 0;
  private static transferCount: number = 0;
  private lastChunkSendTime: number = 0;
  private chunkSendTimings: number[] = [];
  private minChunkDelayMs: number = 0;
  private chunkBuffer: Array<ArrayBuffer | null> = [];
  private maxBufferedChunks: number = 10;
  private acknowledgedChunks: Set<number> = new Set();
  private ackWaitTimeout: NodeJS.Timeout | null = null;
  private readonly ACK_TIMEOUT_MS = 30000;
  private readonly ACK_BACKOFF_MS = [100, 200, 500, 1000, 2000];
  private ackWaitStartTime: number = 0;
  private ackWaitRetryCount: number = 0;
  private unackedCountThreshold: number = 150;
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

    // ✅ ADD: Track chunk resend attempts to prevent infinite loops
  private chunkResendCounts: Map<string, number> = new Map();
  private readonly MAX_CHUNK_RESENDS = 50;
  private lastResendTime: Map<string, number> = new Map();
  private readonly MIN_RESEND_INTERVAL_MS = 1000; // Don't resend same chunk within 1s

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

  public static testChunkSizes(file: File, sizes: number[]): number[] {
    return sizes.map((sz) => Math.ceil(file.size / sz));
  }

  public hasFileChanged(newFile: File): boolean {
    if (!this.file) return false;
    return (
      this.file.name !== newFile.name ||
      this.file.size !== newFile.size ||
      this.file.type !== newFile.type
    );
  }

  public async verifyChunk(idx: number): Promise<boolean> {
    if (!this.chunks || !this.file) return false;
    if (idx < 0 || idx >= this.chunks.length) return false;
    const chunk = this.chunks[idx];
    let arrayBuffer = await chunk.arrayBuffer();
    const hashBuffer = await sha256(arrayBuffer);
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
    return true;
  }

  public enableNetworkStatusListener() {
    if (this._networkListenerAdded) return;
    window.addEventListener("online", this._handleNetworkOnline);
    window.addEventListener("offline", this._handleNetworkOffline);
    this._networkListenerAdded = true;
  }

  private _handleNetworkOnline = () => {
    this._networkOnline = true;
    console.log("[Network] Online");
    this.onNetworkStatusChange?.(true);
  };

  private _handleNetworkOffline = () => {
    this._networkOnline = false;
    console.log("[Network] Offline");
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

  public handleChunkAck(chunkIndex: number) {
    this.acknowledgedChunks.add(chunkIndex);
  }

  public handleAckAll() {
    if (this.chunks) {
      for (let i = 0; i < this.chunks.length; i++) {
        this.acknowledgedChunks.add(i);
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
      this.handleChunkAck(header.chunkIndex);
    } else if (header.type === "ack-all") {
      this.handleAckAll();
    } else if (header.type === "resume-request") {
      console.log(
        `[FileTransferSender] Received resume-request for chunks:`,
        header.missingChunks
      );
      this.handleResumeRequest(header.missingChunks || []);
    }
  }

  public async handleResumeRequest(missingChunks: number[]) {
    if (!this.chunks || !this.file) return;

    console.log(
      `[FileTransferSender] Handling resume-request for ${
        missingChunks.length
      } chunks: [${missingChunks.slice(0, 20).join(", ")}${
        missingChunks.length > 20 ? "..." : ""
      }]`
    );

     // ✅ FIX: Filter out chunks that were recently sent or exceeded retry limit
    const now = Date.now();
    const chunksToResend: number[] = [];
    
    for (const idx of missingChunks) {
      const key = `${this._fileIndex}-${idx}`;
      
      // Check resend count
      const resendCount = this.chunkResendCounts.get(key) || 0;
      if (resendCount >= this.MAX_CHUNK_RESENDS) {
        console.error(`[FileTransferSender] Chunk ${idx} exceeded max resends (${resendCount})`);
        continue;
      }
      
      // Check if we sent this chunk too recently
      const lastSent = this.lastResendTime.get(key) || 0;
      if (now - lastSent < this.MIN_RESEND_INTERVAL_MS) {
        console.warn(`[FileTransferSender] Skipping chunk ${idx} - sent ${now - lastSent}ms ago`);
        continue;
      }
      
      chunksToResend.push(idx);
    }
    
    if (chunksToResend.length === 0) {
      return;
    }

    // Check backpressure before resending batch
    const buffered = this.getBufferedAmount();
    if (buffered > CHUNK_SIZE * 5) {
      console.warn(`[FileTransferSender] High buffered amount (${formatBytes(buffered)}), delaying resends`);
      setTimeout(() => this.handleResumeRequest(missingChunks), 1000);
      return;
    }

    console.log(`[FileTransferSender] Resending ${chunksToResend.length} chunks after filtering`);

    for (const idx of chunksToResend) {
      if (idx >= 0 && idx < this.chunks.length) {
        const key = `${this._fileIndex}-${idx}`;
        
        const chunk = this.chunks[idx];
        let arrayBuffer = await chunk.arrayBuffer();
        let iv: Uint8Array | undefined = undefined;
        const hashBuffer = await sha256(arrayBuffer);
        const hashB64 = btoa(
          String.fromCharCode(...new Uint8Array(hashBuffer))
        );
        if (this.encryptionKey) {
          const ivRaw = window.crypto.getRandomValues(new Uint8Array(12));
          iv = new Uint8Array(ivRaw.buffer.slice(0));
          arrayBuffer = await encryptAESGCM(
            this.encryptionKey,
            arrayBuffer,
            iv as BufferSource
          );
        }
        
        this.sendMessage({
          type: "chunk",
          chunkIndex: idx,
          data: arrayBuffer,
          fileIndex: this._fileIndex,
          ...(iv ? { iv: Array.from(iv) } : {}),
          hash: hashB64,
        });
        
        // ✅ UPDATE: Track resend attempts
        this.chunkResendCounts.set(key, (this.chunkResendCounts.get(key) || 0) + 1);
        this.lastResendTime.set(key, now);
        
        console.log(`[FileTransferSender] Resent chunk ${idx} for file ${this._fileIndex} (attempt ${this.chunkResendCounts.get(key)})`);
        
        // ✅ ADD: Varying delay between resends based on buffered amount
        const currentBuffered = this.getBufferedAmount();
        const resendDelay = currentBuffered > CHUNK_SIZE ? 100 : 30;
        await new Promise(resolve => setTimeout(resolve, resendDelay));
      }
    }
  }

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

  public restoreState(state: any, file: File, resumeChunkIndex?: number) {
    if (!state || !file) return;
    this.file = file;
    this.chunks = this.createChunks(file);
    this._fileIndex = state.fileIndex;
    this.currentChunk =
      typeof resumeChunkIndex === "number"
        ? resumeChunkIndex
        : state.currentChunk;
    this.bytesSent = state.bytesSent;
    this.startTime = state.startTime || Date.now();
    this.isCancelled = false;
    this.sendNextChunk();
  }

  // ✅ FIX: Improved batch transfer start
  public async startBatchTransfer(files: File[]) {
    this.files = files;
    this._fileIndex = 0;

    // ✅ FIX: Add file index to metadata
    const batchMetadata: BatchMetadata = {
      files: files.map((f, idx) => ({
        name: f.name,
        size: f.size,
        type: f.type,
        chunks: Math.ceil(f.size / CHUNK_SIZE),
        relativePath: (f as any).webkitRelativePath || f.name,
        fileIndex: idx, // ✅ ADD: Explicit file index
      })),
    };

    console.log("[FileTransferSender] Sending batch-metadata:", batchMetadata);
    this.sendMessage({ type: "batch-metadata", batchMetadata });

    // Small delay to ensure metadata is received
    await new Promise(resolve => setTimeout(resolve, 100));
    
    await this.startNextFile();
  }

  private async startNextFile() {
    if (typeof (window as any).currentConnectionType === "string") {
      this.connectionType = (window as any).currentConnectionType;
    }

    if (this._fileIndex >= this.files.length) {
      console.log("[FileTransferSender] All files sent, calling onComplete");
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
    this.acknowledgedChunks.clear();
    this.ackWaitStartTime = 0;
    this.ackWaitRetryCount = 0;
    this.chunkResendCounts.clear();
    this.lastResendTime.clear();

    // Preload chunk buffers
    this.chunkBuffer = new Array(this.chunks.length).fill(null);
    for (
      let i = 0;
      i < Math.min(this.chunks.length, this.maxBufferedChunks);
      i++
    ) {
      this.chunks[i].arrayBuffer().then((buf) => {
        this.chunkBuffer[i] = buf;
      });
    }

    // ✅ FIX: Send metadata with file index
    const metadata: FileMetadata = {
      name: file.name,
      size: file.size,
      type: file.type,
      chunks: this.chunks.length,
      relativePath: (file as any).webkitRelativePath || file.name,
      fileIndex: this._fileIndex, // ✅ ADD: Include file index
    };

    console.log(`[FileTransferSender] Starting file ${this._fileIndex}/${this.files.length - 1}:`, metadata);
    this.sendMessage({ type: "metadata", metadata });

    await this.sendNextChunk();
  }

  async startTransfer(file: File) {
    this.file = file;
    this.chunks = this.createChunks(file);
    this.currentChunk = 0;
    this.bytesSent = 0;
    this.isCancelled = false;
    this.startTime = Date.now();

    const metadata: FileMetadata = {
      name: file.name,
      size: file.size,
      type: file.type,
      chunks: this.chunks.length,
      fileIndex: 0,
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
    if (this.currentChunk === this.chunks.length - 1) {
      this.transferSuccess = true;
      FileTransferSender.transferCount++;
      if (this.connectionType === "P2P direct")
        FileTransferSender.p2pSuccessCount++;
      if (this.connectionType === "TURN relay")
        FileTransferSender.relaySuccessCount++;
    }

    if (this.isCancelled) {
      const msg = "Transfer cancelled by user or system.";
      this.onUserError?.(msg);
      return;
    }

    if (this.currentChunk >= this.chunks.length) {
      console.log(
        `[FileTransferSender] All chunks sent for file ${this._fileIndex} (${this.chunks.length})`
      );

      if (typeof this.onFileComplete === "function") {
        this.onFileComplete(this._fileIndex);
      }

      // ✅ FIX: Send complete message ONCE with file index
      this.sendMessage({ 
        type: "complete",
        fileIndex: this._fileIndex // ✅ ADD: Include file index
      });

      // Reset for next file
      this.ackWaitStartTime = 0;
      this.ackWaitRetryCount = 0;
      this.acknowledgedChunks.clear();

      this._fileIndex++;
      
      // ✅ FIX: Add delay before starting next file
      await new Promise(resolve => setTimeout(resolve, 200));
      await this.startNextFile();
      return;
    }

    // Check retry count
    if (!this.chunkRetryCounts[this.currentChunk]) {
      this.chunkRetryCounts[this.currentChunk] = 0;
    }
    if (this.chunkRetryCounts[this.currentChunk] >= this.maxChunkRetries) {
      this.logError(
        `Max retries reached for chunk ${this.currentChunk}. Aborting transfer.`
      );
      this.onError?.(
        new Error(`Max retries reached for chunk ${this.currentChunk}`)
      );
      this.isCancelled = true;
      return;
    }

    // Backpressure
    const sentButUnackedCount =
      this.currentChunk - this.acknowledgedChunks.size;
    if (sentButUnackedCount > this.unackedCountThreshold) {
      setTimeout(() => this.sendNextChunk(), 200);
      return;
    }

    const buffered = this.getBufferedAmount();
    if (buffered > CHUNK_SIZE * 2) {
      setTimeout(() => this.sendNextChunk(), 120);
      return;
    }

    // Get chunk data
    let arrayBuffer: ArrayBuffer;
    if (this.chunkBuffer[this.currentChunk]) {
      arrayBuffer = this.chunkBuffer[this.currentChunk]!;
    } else {
      arrayBuffer = await this.chunks[this.currentChunk].arrayBuffer();
      if (this.currentChunk < this.maxBufferedChunks) {
        this.chunkBuffer[this.currentChunk] = arrayBuffer;
      }
    }

    // Release buffer for sent chunk
    if (
      this.currentChunk > 0 &&
      this.currentChunk - 1 < this.chunkBuffer.length
    ) {
      this.chunkBuffer[this.currentChunk - 1] = null;
    }

    // Compute hash
    const hashBuffer = await sha256(arrayBuffer);
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
    let iv: Uint8Array | undefined = undefined;

    // Encrypt if needed
    if (this.encryptionKey) {
      const ivRaw = window.crypto.getRandomValues(new Uint8Array(12));
      iv = new Uint8Array(ivRaw.buffer.slice(0));
      arrayBuffer = await encryptAESGCM(
        this.encryptionKey,
        arrayBuffer,
        iv as BufferSource
      );
    }

    // ✅ FIX: Send chunk with file index
    this.sendMessage({
      type: "chunk",
      chunkIndex: this.currentChunk,
      fileIndex: this._fileIndex, // ✅ ADD: Include file index
      data: arrayBuffer,
      ...(iv ? { iv: Array.from(iv) } : {}),
      hash: hashB64,
    });

    this.bytesSent += arrayBuffer.byteLength;
    this.sentChunkBitmap[this.currentChunk] = true;
    this.currentChunk++;

    this.updateProgress();

    setTimeout(() => this.sendNextChunk(), this.minChunkDelayMs);
  }

 // 2. In FileTransferSender, update updateProgress method:
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
    fileIndex: this._fileIndex, // ✅ ADD: Include file index
  };

  this.onProgress?.(progress);
}

  private sendMessage(message: ChunkMessage) {
    if (this.getDataChannelState && this.getDataChannelState() !== "open") {
      const msg = "Connection lost. Retrying chunk send...";
      this.logError(msg);
      this.onUserError?.(msg);
      if (typeof this.currentChunk === "number") {
        this.chunkRetryCounts[this.currentChunk] =
          (this.chunkRetryCounts[this.currentChunk] || 0) + 1;
      }
      setTimeout(() => this.sendNextChunk(), 500);
      return;
    }

    const encoder = new TextEncoder();
    const headerObj: any = {
      type: message.type,
      metadata: message.metadata,
      chunkIndex: message.chunkIndex,
      fileIndex: message.fileIndex, // ✅ ADD: Include file index
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
    this.logError("Transfer cancelled by user or system.");
  }
}

// ✅ COMPLETELY REWRITTEN RECEIVER
export class FileTransferReceiver {
  private errorLog: string[] = [];
  private decryptionKey: CryptoKey | null = null;
  private sendDataCallback?: (data: ArrayBuffer | Uint8Array) => boolean;
  
  // ✅ NEW: Store state per file
  private batchMetadata: FileMetadata[] = [];
  private fileStates: Map<number, {
    metadata: FileMetadata;
    receivedChunks: Map<number, ArrayBuffer>;
    receivedChunkBitmap: boolean[];
    bytesReceived: number;
    startTime: number;
    completeMessageReceived: boolean;
    completeWaitStartTime: number;
    completeFileInProgress: boolean; // ✅ ADD: Prevent double completion
  }> = new Map();
  
  private readonly RECEIVER_WAIT_TIMEOUT_MS = 60000;
  
  public onMetadata?: (metadata: FileMetadata) => void;
  public onProgress?: (progress: TransferProgress) => void;
  public onComplete?: (file: Blob, fileIndex: number) => void;
  public onError?: (error: Error) => void;
  public onBatchMetadata?: (batchMetadata: BatchMetadata) => void;

  private logError(msg: string) {
    const timestamp = new Date().toLocaleTimeString();
    this.errorLog.push(`[${timestamp}] ${msg}`);
    console.error(`[FileTransferReceiver] ${msg}`);
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
    if (!this.sendDataCallback) {
      console.warn("[FileTransferReceiver] sendDataCallback not set");
      return;
    }

    const encoder = new TextEncoder();
    const headerObj: any = { type: message.type };
    
    if (message.chunkIndex !== undefined) headerObj.chunkIndex = message.chunkIndex;
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

  private sendAckAll(fileIndex: number) {
    console.log(`[FileTransferReceiver] Sending ack-all for file ${fileIndex}`);
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
    console.log("[FileTransferReceiver] Received batch metadata:", batchMetadata);
    
    this.batchMetadata = batchMetadata.files.map((f, idx) => ({
      ...f,
      fileIndex: f.fileIndex ?? idx, // ✅ Ensure file index is set
    }));

    if (this.onBatchMetadata) {
      this.onBatchMetadata({ files: this.batchMetadata });
    }
  }

  private handleMetadata(metadata: FileMetadata) {
    const fileIndex = metadata.fileIndex ?? 0;
    
    console.log(`[FileTransferReceiver] Received metadata for file ${fileIndex}:`, metadata);
    
    // ✅ Initialize state for this file
    this.fileStates.set(fileIndex, {
      metadata,
      receivedChunks: new Map(),
      receivedChunkBitmap: new Array(metadata.chunks).fill(false),
      bytesReceived: 0,
      startTime: Date.now(),
      completeMessageReceived: false,
      completeWaitStartTime: 0,
      completeFileInProgress: false,
    });

    this.onMetadata?.(metadata);
  }

  private async handleChunk(
    fileIndex: number,
    chunkIndex: number,
    data: ArrayBuffer,
    iv?: number[],
    hash?: string
  ) {
    const state = this.fileStates.get(fileIndex);
    if (!state) {
      console.error(`[FileTransferReceiver] No state for file ${fileIndex}`);
      return;
    }

    // Decrypt if needed
    let chunkData: ArrayBuffer;
    if (this.decryptionKey && iv) {
      try {
        chunkData = await decryptAESGCM(
          this.decryptionKey,
          data,
          new Uint8Array(iv)
        );
      } catch (e) {
        console.error(`[FileTransferReceiver] Decryption failed for chunk ${chunkIndex} of file ${fileIndex}`, e);
        this.onError?.(new Error(`Decryption failed for chunk ${chunkIndex}`));
        return;
      }
    } else {
      chunkData = data;
    }

    // Verify hash
    if (hash) {
      const hashBuffer = await sha256(chunkData);
      const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
      if (hashB64 !== hash) {
        this.logError(`Chunk ${chunkIndex} of file ${fileIndex} integrity check failed`);
        return;
      }
    }

    // Validate index
    if (chunkIndex < 0 || chunkIndex >= state.metadata.chunks) {
      console.error(`[FileTransferReceiver] Invalid chunk index ${chunkIndex} for file ${fileIndex}`);
      return;
    }

    // Check for duplicate
  if (state.receivedChunkBitmap[chunkIndex]) {
    console.warn(`[FileTransferReceiver] Duplicate chunk ${chunkIndex} for file ${fileIndex} - ignoring`);
    return; // ✅ FIX: Don't send ACK for duplicates
  }

    // Store chunk
    state.receivedChunks.set(chunkIndex, chunkData);
    state.receivedChunkBitmap[chunkIndex] = true;
    state.bytesReceived += chunkData.byteLength;

    // Send ack
    this.sendControlMessage({
      type: "chunk-ack",
      chunkIndex,
      fileIndex,
    });

    const receivedCount = state.receivedChunkBitmap.filter((b) => b).length;

    // ✅ FIX: Call updateProgress with fileIndex
    this.updateProgress(fileIndex, state);

  // ✅ FIX: Auto-complete when all chunks received
  if (receivedCount === state.metadata.chunks) {
    console.log(`[FileTransferReceiver] All ${receivedCount} chunks received for file ${fileIndex}`);
    await this.completeFile(fileIndex, state);
  } else if (state.completeMessageReceived) {
    // ✅ FIX: If complete message was received but still missing chunks, request them ONCE
    const missingChunks: number[] = [];
    for (let i = 0; i < state.metadata.chunks; i++) {
      if (!state.receivedChunkBitmap[i]) {
        missingChunks.push(i);
      }
    }
    
    if (missingChunks.length > 0 && missingChunks.length <= 5) { // Only if very few chunks missing
      console.log(`[FileTransferReceiver] Requesting ${missingChunks.length} remaining chunks during stream`);
      this.sendControlMessage({
        type: "resume-request",
        missingChunks,
        fileIndex,
      });
    }
  }
}


// 3. In FileTransferReceiver, update updateProgress method:
private updateProgress(fileIndex: number, state: any) {
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
    fileIndex, // ✅ ADD: Include file index
  };

  this.onProgress?.(progress);
}

private async handleComplete(fileIndex: number) {
  const state = this.fileStates.get(fileIndex);
  if (!state) {
    console.error(`[FileTransferReceiver] No state for file ${fileIndex}`);
    return;
  }

  console.log(`[FileTransferReceiver] Complete message for file ${fileIndex}`);

  // Mark that complete message was received
  state.completeMessageReceived = true;

  // Check if all chunks received
  const receivedCount = state.receivedChunkBitmap.filter((b) => b).length;
  
  if (receivedCount === state.metadata.chunks) {
    // All chunks present, complete immediately
    await this.completeFile(fileIndex, state);
  } else {
    // Wait for missing chunks
    const missingChunks: number[] = [];
    for (let i = 0; i < state.metadata.chunks; i++) {
      if (!state.receivedChunkBitmap[i]) {
        missingChunks.push(i);
      }
    }

    console.log(`[FileTransferReceiver] File ${fileIndex} missing ${missingChunks.length} chunks, requesting...`);
    
    // ✅ FIX: Initialize wait tracking
    if (state.completeWaitStartTime === 0) {
      state.completeWaitStartTime = Date.now();
    }

    // ✅ FIX: Check timeout BEFORE sending request
    const elapsed = Date.now() - state.completeWaitStartTime;
    if (elapsed > this.RECEIVER_WAIT_TIMEOUT_MS) {
      this.onError?.(new Error(`Timeout waiting for ${missingChunks.length} chunks of file ${fileIndex}`));
      return;
    }

    this.sendControlMessage({
      type: "resume-request",
      missingChunks,
      fileIndex,
    });

    // ✅ FIX: Use a more conservative backoff for retry check
    const retryDelay = Math.min(5000, 2000 + (elapsed / 5)); 
    console.log(`[FileTransferReceiver] Will check again in ${retryDelay}ms if needed (elapsed: ${elapsed}ms)`);
    
    setTimeout(() => {
      // Only retry if still incomplete
      const currentState = this.fileStates.get(fileIndex);
      if (!currentState || currentState.completeFileInProgress) return; // File completed or clean up
      
      const currentReceived = currentState.receivedChunkBitmap.filter((b) => b).length;
      if (currentReceived < currentState.metadata.chunks) {
        console.log(`[FileTransferReceiver] Retrying complete check for file ${fileIndex} (${currentReceived}/${currentState.metadata.chunks})`);
        this.handleComplete(fileIndex);
      }
    }, retryDelay);
  }
}

  private async completeFile(fileIndex: number, state: any) {
    if (state.completeFileInProgress) return;
    state.completeFileInProgress = true;
    console.log(`[FileTransferReceiver] Completing file ${fileIndex}`);

    // Build chunks array
    const chunks: ArrayBuffer[] = [];
    for (let i = 0; i < state.metadata.chunks; i++) {
      const chunk = state.receivedChunks.get(i);
      if (!chunk) {
        this.onError?.(new Error(`Missing chunk ${i} for file ${fileIndex}`));
        return;
      }
      chunks.push(chunk);
    }

    // Create blob
    const blob = new Blob(chunks, { type: state.metadata.type });

    // Validate size
    if (blob.size !== state.metadata.size) {
      const errorMsg = `File size mismatch for ${state.metadata.name}: received ${blob.size} bytes, expected ${state.metadata.size} bytes`;
      console.error(`[FileTransferReceiver] ${errorMsg}`);
      this.onError?.(new Error(errorMsg));
      return;
    }

    // Calculate hash for verification
    const arrayBuffer = await blob.arrayBuffer();
    const hashBuffer = await sha256(arrayBuffer);
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
    
    console.log(`[FileTransferReceiver] ✅ File ${fileIndex} complete:`, {
      name: state.metadata.name,
      size: blob.size,
      sha256: hashB64,
    });

    // Send ack-all
    this.sendAckAll(fileIndex);

    // Call completion callback
    if (typeof this.onComplete === "function") {
      this.onComplete(blob, fileIndex);
    }

    // Clean up state
    this.fileStates.delete(fileIndex);
  }

  reset() {
    this.batchMetadata = [];
    this.fileStates.clear();
  }
}

// Utility functions
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