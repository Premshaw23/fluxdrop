// fluxdrop-web/app/send/page.tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Upload, Copy, Check, Wifi } from 'lucide-react';
import Link from 'next/link';
import { SignalingClient } from '@/lib/signaling/SignalingClient';
import { RTCConnection } from '@/lib/webrtc/RTCConnection';
import { FileTransferSender, formatBytes, formatSpeed, formatTime } from '@/lib/transfer/FileTransfer';
import { generateECDHKeyPair, exportPublicKey, importPublicKey, deriveSharedSecret } from '@/lib/crypto/crypto';

type Step = 'select' | 'waiting' | 'connected' | 'transferring' | 'complete';

export default function SendPage() {
    // Add state to store file debug info
    const [fileDebugInfo, setFileDebugInfo] = useState<Array<{hash?: string, type?: string, size?: number, hex?: string}>>([]);
  // ECDH state
  const ecdhKeyPairRef = useRef<{ publicKey: CryptoKey, privateKey: CryptoKey } | null>(null);
  const peerPublicKeyRef = useRef<CryptoKey | null>(null);
  const sharedSecretRef = useRef<CryptoKey | null>(null);
    // Drag & drop state
    const [isDragActive, setIsDragActive] = useState(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();
  const [step, setStep] = useState<Step>('select');
  const [files, setFiles] = useState<File[]>([]);
  const [sessionCode, setSessionCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [progressList, setProgressList] = useState<number[]>([]);
  const [speedList, setSpeedList] = useState<number[]>([]);
  const [timeRemainingList, setTimeRemainingList] = useState<number[]>([]);
  const [error, setError] = useState('');

  const signalingRef = useRef<SignalingClient | null>(null);
  const rtcRef = useRef<RTCConnection | null>(null);
  const transferRef = useRef<FileTransferSender | null>(null);
  const dataChannelReadyRef = useRef(false);
  const filesRef = useRef<File[]>([]);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      transferRef.current?.cancel();
      rtcRef.current?.close();
      signalingRef.current?.disconnect();
    };
  }, []);

  const handleFiles = (selectedFiles: File[]) => {
    if (selectedFiles.length === 0) return;
    setFiles(selectedFiles);
    filesRef.current = selectedFiles;
    setProgressList(new Array(selectedFiles.length).fill(0));
    setSpeedList(new Array(selectedFiles.length).fill(0));
    setTimeRemainingList(new Array(selectedFiles.length).fill(0));
    setStep('waiting');
    initializeConnection();
    setTimeout(() => {
      if (dataChannelReadyRef.current && filesRef.current.length > 0) {
        startTransfer(filesRef.current);
      }
    }, 0);
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files ? Array.from(event.target.files) : [];
    // ...existing code...
    handleFiles(selectedFiles);
  };

  // Drag & drop handlers
  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    let droppedFiles: File[] = [];
    const traverseFileTree = (item: any, path = "") => {
      return new Promise<File[]>((resolve) => {
        if (item.isFile) {
          item.file((file: File) => {
            file = new File([file], path + file.name, { type: file.type });
            resolve([file]);
          });
        } else if (item.isDirectory) {
          const dirReader = item.createReader();
          dirReader.readEntries(async (entries: any[]) => {
            const files = await Promise.all(entries.map((entry) => traverseFileTree(entry, path + item.name + "/")));
            resolve(files.flat());
          });
        } else {
          resolve([]);
        }
      });
    };

    if (event.dataTransfer.items) {
      const items = Array.from(event.dataTransfer.items);
      Promise.all(items.map(async (item) => {
        const entry = (item as any).webkitGetAsEntry?.();
        if (entry) {
          return await traverseFileTree(entry);
        } else if (item.kind === 'file') {
          const file = item.getAsFile();
          return file ? [file] : [];
        }
        return [];
      })).then((results) => {
        droppedFiles = results.flat();
        // ...existing code...
        handleFiles(droppedFiles);
      });
    } else {
      droppedFiles = Array.from(event.dataTransfer.files);
      // ...existing code...
      handleFiles(droppedFiles);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
  };

  const initializeConnection = async () => {
    try {
      // Connect to signaling server
      const signalingUrl = process.env.NEXT_PUBLIC_SIGNALING_URL || 'ws://localhost:3001';
      const signaling = new SignalingClient(signalingUrl);
      signalingRef.current = signaling;

      await signaling.connect();

      // Initialize WebRTC
      const rtc = new RTCConnection({
        onStateChange: (state) => {
          // ...existing code...
          if (state === 'connected') {
            setStep('connected');
          } else if (state === 'failed') {
            setError('Connection failed. Please try again.');
          }
        },
        onDataChannelOpen: () => {
          // ...existing code...
          dataChannelReadyRef.current = true;
          // If files are already selected, start transfer now
          if (filesRef.current.length > 0) {
            // ...existing code...
            startTransfer(filesRef.current);
          }
        },
        onError: (err) => {
          // ...existing code...
          setError(err.message);
        }
      });
      rtcRef.current = rtc;

      await rtc.initialize('sender');

      // Handle signaling messages
      signaling.on('session-created', (message) => {
        setSessionCode(message.code);
      });


      signaling.on('peer-joined', async () => {
        setStep('connected');
        // ECDH: generate key pair and send public key
        const keyPair = await generateECDHKeyPair();
        ecdhKeyPairRef.current = keyPair;
        const exported = await exportPublicKey(keyPair.publicKey);
        const pubKeyB64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
        signaling.sendPublicKey(pubKeyB64);
        // Create and send offer
        const offer = await rtc.createOffer();
        signaling.sendOffer(offer.sdp!);
      });

      signaling.on('public-key', async (message) => {
        // Receive peer's public key, import, and derive shared secret
        const raw = Uint8Array.from(atob(message.publicKey), c => c.charCodeAt(0));
        const peerKey = await importPublicKey(raw.buffer);
        peerPublicKeyRef.current = peerKey;
        if (ecdhKeyPairRef.current) {
          sharedSecretRef.current = await deriveSharedSecret(ecdhKeyPairRef.current.privateKey, peerKey);
          console.log('[SendPage] Shared secret derived');
        }
      });

      signaling.on('answer', async (message) => {
        await rtc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
      });

      signaling.on('ice-candidate', async (message) => {
        await rtc.addIceCandidate(message.candidate);
      });

      signaling.on('error', (message) => {
        // ...existing code...
        setError(message.error);
      });

      signaling.on('peer-disconnected', () => {
        // ...existing code...
        setError('Receiver disconnected. Please try again or resend files.');
        setStep('select');
        transferRef.current?.cancel();
        rtcRef.current?.close();
        signalingRef.current?.disconnect();
      });

      // Handle ICE candidates
      rtc.onIceCandidate = (candidate) => {
        signaling.sendIceCandidate(candidate);
      };

      // Create session
      signaling.createSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize connection');
    }
  };

  // Multi-file batch transfer using new protocol
  const startTransfer = async (selectedFiles: File[]) => {
    // ...existing code...
    if (!selectedFiles.length || !rtcRef.current) {
      // ...existing code...
      return;
    }

    if (!sharedSecretRef.current) {
      setError('Encryption handshake not complete. Please wait for the connection to establish before sending files.');
      // ...existing code...
      return;
    }
    // Calculate debug info for each file before transfer
    Promise.all(selectedFiles.map(async (file) => {
      const arrayBuffer = await file.arrayBuffer();
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', arrayBuffer);
      const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
      const hex = Array.from(new Uint8Array(arrayBuffer).slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      return {
        hash: hashB64,
        type: file.type,
        size: file.size,
        hex
      };
    })).then(setFileDebugInfo);
    setStep('transferring');
    const transfer = new FileTransferSender(
      (data) => rtcRef.current!.send(data),
      () => rtcRef.current!.getBufferedAmount(),
      () => rtcRef.current!.getDataChannelState()
    );
    transfer.setEncryptionKey(sharedSecretRef.current);
    transferRef.current = transfer;
    transfer.onProgress = (prog) => {
      const fileIdx = transfer.fileIndex;
      setProgressList((prev) => {
        const updated = [...prev];
        updated[fileIdx] = prog.percentage;
        return updated;
      });
      setSpeedList((prev) => {
        const updated = [...prev];
        updated[fileIdx] = prog.speed;
        return updated;
      });
      setTimeRemainingList((prev) => {
        const updated = [...prev];
        updated[fileIdx] = prog.timeRemaining;
        return updated;
      });
    };
    transfer.onComplete = () => {
      setProgressList((prev) => prev.map(() => 100));
      setStep('complete');
      // Clear keys after transfer
      ecdhKeyPairRef.current = null;
      peerPublicKeyRef.current = null;
      sharedSecretRef.current = null;
    };
    transfer.onError = (err) => {
      // ...existing code...
      setError(err.message);
      // Clear keys on error
      ecdhKeyPairRef.current = null;
      peerPublicKeyRef.current = null;
      sharedSecretRef.current = null;
    };
    await transfer.startBatchTransfer(selectedFiles);
  };

  const copyCode = () => {
    navigator.clipboard.writeText(sessionCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const reset = () => {
    // ...existing code...
    transferRef.current?.cancel();
    rtcRef.current?.close();
    signalingRef.current?.disconnect();
    // Reset all refs to initial state
    dataChannelReadyRef.current = false;
    filesRef.current = [];
    transferRef.current = null;
    rtcRef.current = null;
    signalingRef.current = null;
    setStep('select');
    setFiles([]);
    setSessionCode('');
    setProgressList([]);
    setSpeedList([]);
    setTimeRemainingList([]);
    setError('');
    // Only reset file input value here
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-blue-50 via-white to-purple-50">
      {/* Debug UI removed */}
      {/* Mobile viewport meta tag for App Router (if not already in _app or layout) */}
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
      </head>
      {/* Header */}
      <header className="border-b bg-white/50 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4">
          <Link href="/" className="inline-flex items-center gap-2 text-gray-700 hover:text-gray-900">
            <ArrowLeft className="w-5 h-5" />
            <span>Back</span>
          </Link>
        </div>
      </header>

      <main className="container mx-auto px-2 py-8 sm:px-4 sm:py-16">
        <div className="max-w-2xl mx-auto">
          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
              {error}
            </div>
          )}

          {/* Select Files with Drag & Drop */}
          {step === 'select' && (
            <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-8">
              <div className="text-center mb-8">
                <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Upload className="w-10 h-10 text-blue-600" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-2">Send Files</h2>
                <p className="text-gray-600">Choose one or more files to share instantly</p>
              </div>

              <label className="block">
                <input
                  type="file"
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
                  ref={fileInputRef}
                />
                <div
                  className={`border-2 border-dashed rounded-xl p-6 sm:p-12 text-center cursor-pointer transition-colors select-none ${isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-500 hover:bg-blue-50'}`}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  role="button"
                  tabIndex={0}
                  aria-label="Select files to send"
                  style={{ touchAction: 'manipulation' }}
                >
                  <Upload className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-lg text-gray-700 mb-2">Tap or drag files here</p>
                  <p className="text-sm text-gray-500">Any file up to 2GB each</p>
                  {isDragActive && (
                    <div className="mt-2 text-blue-600 font-semibold">Drop files to select</div>
                  )}
                </div>
              </label>

              {/* Selected files preview */}
              {files.length > 0 && (
                <div className="mt-4 sm:mt-6 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                  {files.map((f, idx) => {
                    const isImage = f.type.startsWith('image/');
                    const isVideo = f.type.startsWith('video/');
                    const isAudio = f.type.startsWith('audio/');
                    return (
                      <div key={f.name + f.size} className="bg-gray-50 rounded-lg p-4 flex flex-col items-center shadow">
                        {isImage ? (
                          <img
                            src={URL.createObjectURL(f)}
                            alt={f.name}
                            className="w-24 h-24 object-cover rounded mb-2 border"
                            onLoad={e => URL.revokeObjectURL((e.target as HTMLImageElement).src)}
                          />
                        ) : isVideo ? (
                          <div className="w-24 h-24 flex items-center justify-center bg-gray-200 rounded mb-2">
                            <span className="text-xs text-gray-500">Video</span>
                          </div>
                        ) : isAudio ? (
                          <div className="w-24 h-24 flex items-center justify-center bg-gray-200 rounded mb-2">
                            <span className="text-xs text-gray-500">Audio</span>
                          </div>
                        ) : (
                          <div className="w-24 h-24 flex items-center justify-center bg-gray-200 rounded mb-2">
                            <span className="text-xs text-gray-500">{f.type ? f.type.split('/')[1] : 'File'}</span>
                          </div>
                        )}
                        <span className="font-medium text-gray-900 break-all text-center text-sm mb-1">{f.name}</span>
                        <span className="text-xs text-gray-600">{formatBytes(f.size)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Waiting for Receiver */}
          {step === 'waiting' && (
            <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-8 animate-fade-in">
              <div className="text-center mb-8">
                <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-bounce-slow">
                  <Wifi className="w-10 h-10 text-blue-600 animate-pulse" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-2 animate-fade-in">Share This Code</h2>
                <p className="text-gray-600 animate-fade-in">Waiting for receiver to join...</p>
              </div>

              {/* File Info */}
              {files.length > 0 && (
                <div className="bg-gray-50 rounded-lg p-4 mb-6 animate-fade-in">
                  <p className="text-sm text-gray-500 mb-1">Selected files:</p>
                  <ul className="space-y-1">
                    {files.map((f, idx) => (
                      <li key={f.name + f.size} className="flex justify-between items-center">
                        <span className="font-semibold text-gray-900">{f.name}</span>
                        <span className="text-sm text-gray-600">{formatBytes(f.size)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Session Code */}
              <div className="bg-blue-50 rounded-xl p-6 mb-6 animate-fade-in">
                <p className="text-sm text-gray-600 mb-2 text-center">Transfer Code</p>
                <div className="text-6xl font-bold text-blue-600 text-center tracking-wider mb-4 animate-fade-in">
                  {sessionCode || '------'}
                </div>
                {sessionCode && (
                  <button
                    onClick={copyCode}
                    className="w-full bg-white border border-blue-200 text-blue-600 py-3 px-4 rounded-lg hover:bg-blue-50 transition-colors flex items-center justify-center gap-2 animate-fade-in"
                  >
                    {copied ? (
                      <>
                        <Check className="w-5 h-5" />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="w-5 h-5" />
                        Copy Code
                      </>
                    )}
                  </button>
                )}
              </div>

              <p className="text-center text-sm text-gray-500 animate-fade-in">
                Code expires in 5 minutes
              </p>
            </div>
          )}

          {/* Connected */}
          {step === 'connected' && (
            <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-8 text-center">
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Check className="w-10 h-10 text-green-600" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-2">Connected!</h2>
              <p className="text-gray-600">Starting transfer...</p>
            </div>
          )}

          {/* Transferring */}
          {step === 'transferring' && (
            <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-8">
              <h2 className="text-3xl font-bold text-gray-900 mb-6 text-center">Sending Files</h2>

              {files.length > 0 && (
                <div className="mb-4 sm:mb-6">
                  <ul className="space-y-2">
                    {files.map((f, idx) => (
                      <li key={f.name + f.size} className="bg-gray-50 rounded-lg px-2 py-2 sm:px-4">
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-1">
                          <span className="font-semibold text-gray-900 break-all">{f.name}</span>
                          <span className="text-sm text-gray-600 mt-1 sm:mt-0">{formatBytes(f.size)}</span>
                        </div>
                        {/* Progress Bar for each file */}
                        <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-600 transition-all duration-300"
                            style={{ width: `${progressList[idx] || 0}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-xs text-gray-500 mt-1">
                          <span>{Math.round(progressList[idx] || 0)}%</span>
                          <span>{formatSpeed(speedList[idx] || 0)}</span>
                          <span>{timeRemainingList[idx] > 0 ? `${formatTime(timeRemainingList[idx])} left` : ''}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Complete */}
          {step === 'complete' && (
            <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-8 text-center">
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Check className="w-10 h-10 text-green-600" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-2">Transfer Complete!</h2>
              <p className="text-gray-600 mb-6">Your files were sent successfully</p>

              <button
                onClick={reset}
                className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg hover:bg-blue-700 transition-colors font-semibold"
              >
                Send More Files
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}