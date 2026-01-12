// fluxdrop-web/app/receive/page.tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { ArrowLeft, Download, Check } from 'lucide-react';
import Link from 'next/link';
import { SignalingClient } from '@/lib/signaling/SignalingClient';
import { RTCConnection } from '@/lib/webrtc/RTCConnection';
import { FileTransferReceiver, FileMetadata, formatBytes, formatSpeed, formatTime } from '@/lib/transfer/FileTransfer';
import { generateECDHKeyPair, exportPublicKey, importPublicKey, deriveSharedSecret } from '@/lib/crypto/crypto';

type Step = 'enter-code' | 'connecting' | 'receiving' | 'complete';

export default function ReceivePage() {
  // ECDH state
  const ecdhKeyPairRef = useRef<{ publicKey: CryptoKey, privateKey: CryptoKey } | null>(null);
  const peerPublicKeyRef = useRef<CryptoKey | null>(null);
  const sharedSecretRef = useRef<CryptoKey | null>(null);
  const [step, setStep] = useState<Step>('enter-code');
  const [code, setCode] = useState('');
  const [batchMetadata, setBatchMetadata] = useState<FileMetadata[]>([]);
  const [metadataList, setMetadataList] = useState<(FileMetadata | null)[]>([]);
  const [progressList, setProgressList] = useState<number[]>([]);
  const [speedList, setSpeedList] = useState<number[]>([]);
  const [timeRemainingList, setTimeRemainingList] = useState<number[]>([]);
  const [receivedFiles, setReceivedFiles] = useState<(Blob | null)[]>([]);
  const [error, setError] = useState('');
  // Add a handshake-in-progress state
  const [handshakeInProgress, setHandshakeInProgress] = useState(false);

  // Add state to store file debug info
  const [fileDebugInfo, setFileDebugInfo] = useState<Array<{hash?: string, type?: string, size?: number, hex?: string}>>([]);

  const signalingRef = useRef<SignalingClient | null>(null);
  const rtcRef = useRef<RTCConnection | null>(null);
  const transferRef = useRef<FileTransferReceiver | null>(null);
  const fileIndexRef = useRef(0);

  useEffect(() => {
    return () => {
      rtcRef.current?.close();
      signalingRef.current?.disconnect();
    };
  }, []);

  const handleJoinSession = async () => {
    if (code.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }
    setStep('connecting');
    setError('');
    setHandshakeInProgress(true);

    try {
      // Connect to signaling server
      const signalingUrl = process.env.NEXT_PUBLIC_SIGNALING_URL || 'ws://localhost:3001';
      const signaling = new SignalingClient(signalingUrl);
      signalingRef.current = signaling;

      await signaling.connect();

      // Initialize WebRTC
      const rtc = new RTCConnection({
        onStateChange: (state) => {
          console.log('Connection state:', state);
          if (state === 'failed') {
            setError('Connection failed. Please try again.');
          }
        },
        onDataChannelOpen: () => {
          console.log('Data channel ready');
        },
        onMessage: (data) => {
          transferRef.current?.handleMessage(data);
        },
        onError: (err) => {
          setError(err.message);
        }
      });
      rtcRef.current = rtc;

      await rtc.initialize('receiver');

      // Defer FileTransferReceiver setup until shared secret is derived
      let transfer: FileTransferReceiver | null = null;
      const setupTransferReceiver = () => {
        if (!sharedSecretRef.current) {
          setError('Encryption handshake not complete. Please wait for the connection to establish before receiving files.');
          console.error('[ReceivePage] Cannot start receiving: shared secret not set.');
          return;
        }
        // Set up transfer and handlers synchronously before any messages can arrive
        transfer = new FileTransferReceiver();
        transfer.setDecryptionKey(sharedSecretRef.current);
        transferRef.current = transfer;
        // Attach all handlers immediately
        transfer.onBatchMetadata = (batch) => {
          const files = (batch as any)?.files || (batch as any)?.batchMetadata?.files;
          console.log('[ReceivePage] onBatchMetadata called:', batch, files);
          if (!files) return;
          setBatchMetadata((prev) => {
            if (prev.length === 0) {
              console.log('[ReceivePage] setBatchMetadata:', files);
              return files;
            } else {
              return prev;
            }
          });
          setMetadataList(files.map(() => null));
          setProgressList(new Array(files.length).fill(0));
          setSpeedList(new Array(files.length).fill(0));
          setTimeRemainingList(new Array(files.length).fill(0));
          setReceivedFiles(new Array(files.length).fill(null));
          fileIndexRef.current = 0; // Reset file index for new batch
        };
        transfer.onMetadata = (meta: FileMetadata) => {
          setMetadataList((prev) => {
            const updated = [...prev];
            // Find the index in batchMetadata that matches this meta
            let idx = batchMetadata.findIndex(
              (m) => m.name === meta.name && m.size === meta.size && m.type === meta.type
            );
            // Fallback: first null slot
            if (idx === -1) idx = updated.findIndex((m) => m === null);
            // Fallback: fileIndexRef
            if (idx === -1) idx = fileIndexRef.current;
            updated[idx] = meta;
            return updated;
          });
          setStep('receiving');
        };
        transfer.onProgress = (prog: any) => {
          setProgressList((prev) => {
            const updated = [...prev];
            updated[fileIndexRef.current] = prog.percentage;
            return updated;
          });
          setSpeedList((prev) => {
            const updated = [...prev];
            updated[fileIndexRef.current] = prog.speed;
            return updated;
          });
          setTimeRemainingList((prev) => {
            const updated = [...prev];
            updated[fileIndexRef.current] = prog.timeRemaining;
            return updated;
          });
        };
        transfer.onComplete = async (file: Blob, completedFileIndex: number) => {
          // Calculate SHA-256 and hex preview
          const arrayBuffer = await file.arrayBuffer();
          const hashBuffer = await window.crypto.subtle.digest('SHA-256', arrayBuffer);
          const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
          const hex = Array.from(new Uint8Array(arrayBuffer).slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
          setFileDebugInfo((prev) => {
            const updated = [...prev];
            updated[completedFileIndex] = {
              hash: hashB64,
              type: file.type,
              size: file.size,
              hex
            };
            return updated;
          });
          // Ensure metadataList is set for this file
          setMetadataList((prev) => {
            const updated = [...prev];
            if (!updated[completedFileIndex] && batchMetadata[completedFileIndex]) {
              updated[completedFileIndex] = batchMetadata[completedFileIndex];
            }
            return updated;
          });
          setReceivedFiles((prev) => {
            const updated = [...prev];
            updated[completedFileIndex] = file;
            console.log('[ReceivePage] setReceivedFiles:', updated);
            const totalFiles = batchMetadata.length || 1;
            const receivedCount = updated.filter(Boolean).length;
            if (receivedCount >= totalFiles) {
              console.log('[ReceivePage] All files received, setting step to complete');
              setStep('complete');
              ecdhKeyPairRef.current = null;
              peerPublicKeyRef.current = null;
              sharedSecretRef.current = null;
            }
            return updated;
          });
          fileIndexRef.current++;
        };
        transfer.onError = (err) => {
          setError(err.message);
          ecdhKeyPairRef.current = null;
          peerPublicKeyRef.current = null;
          sharedSecretRef.current = null;
        };
      };
      // Wait for shared secret, then setup transfer receiver
      const waitForSharedSecret = () => {
        if (sharedSecretRef.current) {
          setHandshakeInProgress(false);
          // Set up transfer receiver synchronously before any messages can arrive
          setupTransferReceiver();
        } else {
          setTimeout(waitForSharedSecret, 50);
        }
      };
      waitForSharedSecret();

      // Handle signaling messages

      signaling.on('session-joined', async () => {
        signaling.on('peer-disconnected', () => {
          console.warn('[ReceivePage] Peer disconnected');
          setError('Sender disconnected. Please try again or receive more files.');
          setStep('enter-code');
          rtcRef.current?.close();
          signalingRef.current?.disconnect();
        });
        // ECDH: generate key pair and send public key
        const keyPair = await generateECDHKeyPair();
        ecdhKeyPairRef.current = keyPair;
        const exported = await exportPublicKey(keyPair.publicKey);
        const pubKeyB64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
        signaling.sendPublicKey(pubKeyB64);
        console.log('Joined session, public key sent');
        setStep('receiving');
      });

      signaling.on('public-key', async (message) => {
        // Receive peer's public key, import, and derive shared secret
        const raw = Uint8Array.from(atob(message.publicKey), c => c.charCodeAt(0));
        const peerKey = await importPublicKey(raw.buffer);
        peerPublicKeyRef.current = peerKey;
        if (ecdhKeyPairRef.current) {
          sharedSecretRef.current = await deriveSharedSecret(ecdhKeyPairRef.current.privateKey, peerKey);
          console.log('[ReceivePage] Shared secret derived');
        }
      });

      // Move offer/ice-candidate handlers here, after RTC is initialized
      signaling.on('offer', async (message) => {
        await rtc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        const answer = await rtc.createAnswer();
        signaling.sendAnswer(answer.sdp!);
      });

      signaling.on('ice-candidate', async (message) => {
        await rtc.addIceCandidate(message.candidate);
      });

      signaling.on('error', (message) => {
        setError(message.error || 'Session not found or expired. Please check the code and try again.');
        setStep('enter-code');
      });

      // Handle ICE candidates
      rtc.onIceCandidate = (candidate) => {
        signaling.sendIceCandidate(candidate);
      };

      // Join session
      signaling.joinSession(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
      setStep('enter-code');
      setHandshakeInProgress(false);
    }
  };

  const getFallbackMeta = (file: Blob | null, idx: number) => {
    if (!file) return null;
    return {
      name: `File_${idx + 1}.${(file.type && file.type.split('/')[1]) || 'bin'}`,
      size: file.size,
      type: file.type || 'application/octet-stream',
      chunks: 1
    };
  };

  const handleDownload = (fileIndex: number) => {
    const file = receivedFiles[fileIndex];
    let meta = metadataList[fileIndex];
    if (!file) return;
    if (!meta) meta = getFallbackMeta(file, fileIndex);
    if (!meta) return;
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = meta.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    rtcRef.current?.close();
    signalingRef.current?.disconnect();
    transferRef.current?.reset();
    setStep('enter-code');
    setCode('');
    setBatchMetadata([]);
    setMetadataList([]);
    setProgressList([]);
    setSpeedList([]);
    setTimeRemainingList([]);
    setReceivedFiles([]);
    setError('');
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-blue-50 via-white to-purple-50">
      {/* Header */}
      <header className="border-b bg-white/50 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4">
          <Link href="/" className="inline-flex items-center gap-2 text-gray-700 hover:text-gray-900">
            <ArrowLeft className="w-5 h-5" />
            <span>Back</span>
          </Link>
        </div>
      </header>
      {/* Handshake progress indicator */}
      {handshakeInProgress && (
        <div className="flex flex-col items-center justify-center mt-8">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mb-4"></div>
          <p className="text-purple-700 font-semibold text-lg">Establishing secure connection…</p>
          <p className="text-gray-500 text-sm mt-2">Waiting for encryption handshake to complete…</p>
        </div>
      )}
      {/* ...existing code... */}
      <main className="container mx-auto px-4 py-16">
        <div className="max-w-2xl mx-auto">
          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
              {error}
            </div>
          )}

          {/* Enter Code */}
          {step === 'enter-code' && (
            <div className="bg-white rounded-2xl shadow-xl p-8">
              <div className="text-center mb-8">
                <div className="w-20 h-20 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Download className="w-10 h-10 text-purple-600" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-2">Receive a File</h2>
                <p className="text-gray-600">Enter the 6-digit code from the sender</p>
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Transfer Code
                </label>
                <input
                  type="text"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="w-full text-4xl font-bold text-center tracking-widest p-4 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:outline-none"
                  autoFocus
                />
              </div>

              <button
                onClick={handleJoinSession}
                disabled={code.length !== 6}
                className="w-full bg-purple-600 text-white py-4 px-6 rounded-lg hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-semibold text-lg"
              >
                Connect
              </button>
            </div>
          )}

          {/* Connecting */}
          {step === 'connecting' && (
            <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
              <div className="w-20 h-20 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
                <Download className="w-10 h-10 text-purple-600" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-2">Connecting...</h2>
              <p className="text-gray-600">Establishing secure connection</p>
            </div>
          )}

          {/* Receiving */}
          {step === 'receiving' && (
            <div className="bg-white rounded-2xl shadow-xl p-8">
              <h2 className="text-3xl font-bold text-gray-900 mb-6 text-center">Receiving Files</h2>
              {metadataList.length > 0 && (
                <div className="mb-6">
                  <ul className="space-y-2">
                    {metadataList.map((meta, idx) => (
                      meta ? (
                        <li key={meta.name + meta.size} className="bg-gray-50 rounded-lg px-4 py-2">
                          <div className="flex justify-between items-center mb-1">
                            <span className="font-semibold text-gray-900">{meta.name}</span>
                            <span className="text-sm text-gray-600">{formatBytes(meta.size)}</span>
                          </div>
                          {/* Progress Bar for each file */}
                          <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-purple-600 transition-all duration-300"
                              style={{ width: `${progressList[idx] || 0}%` }}
                            />
                          </div>
                          <div className="flex justify-between text-xs text-gray-500 mt-1">
                            <span>{Math.round(progressList[idx] || 0)}%</span>
                            <span>{formatSpeed(speedList[idx] || 0)}</span>
                            <span>{timeRemainingList[idx] > 0 ? `${formatTime(timeRemainingList[idx])} left` : ''}</span>
                          </div>
                        </li>
                      ) : null
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Complete */}
          {step === 'complete' && (
            <div className="bg-white rounded-2xl shadow-xl p-8">
              <div className="text-center mb-6">
                <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Check className="w-10 h-10 text-green-600" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-2">Transfer Complete!</h2>
                <p className="text-gray-600">Your files are ready to download</p>
              </div>
                {/* DEBUG: Show state arrays for troubleshooting */}
                <div className="mb-4 p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-900">
                  <div><b>batchMetadata:</b> {JSON.stringify(batchMetadata)}</div>
                  <div><b>metadataList:</b> {JSON.stringify(metadataList)}</div>
                  <div><b>receivedFiles:</b> {JSON.stringify(receivedFiles.map(f => f ? {size: f.size, type: f.type} : null))}</div>
                </div>
              <div className="bg-gray-50 rounded-lg p-4 mb-6">
                <ul className="space-y-2">
                  {Array.from({ length: Math.max(metadataList.length, receivedFiles.length) }).map((_, idx) => {
                    // Use the largest length among batchMetadata, metadataList, receivedFiles
                    const maxLen = Math.max(batchMetadata.length, metadataList.length, receivedFiles.length);
                    let meta = (batchMetadata[idx] || metadataList[idx]) || null;
                    const file = receivedFiles[idx] || null;
                    // If file exists but no metadata, create fallback metadata
                    if (!meta && file) {
                      meta = {
                        name: `File_${idx + 1}.${(file.type && file.type.split('/')[1]) || 'bin'}`,
                        size: file.size,
                        type: file.type || 'application/octet-stream',
                        chunks: 1
                      };
                    }
                    if (!meta) {
                      return (
                        <li key={idx} className="flex justify-between items-center opacity-50">
                          <span className="font-semibold text-gray-400">File not ready</span>
                        </li>
                      );
                    }
                    const url = file ? URL.createObjectURL(file) : undefined;
                    const isImage = meta.type && meta.type.startsWith('image/');
                    return (
                      <li key={meta.name + meta.size} className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                        <div className="flex flex-col gap-1 md:flex-row md:items-center">
                          <span className={file ? "font-semibold text-gray-900" : "font-semibold text-gray-400 line-through"}>{meta.name}</span>
                          <span className="text-sm text-gray-600 md:ml-4">{formatBytes(meta.size)}</span>
                        </div>
                        <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4">
                          {file ? (
                            <>
                              {isImage && url && (
                                <img
                                  src={url}
                                  alt={meta.name}
                                  style={{ maxWidth: 120, maxHeight: 80, borderRadius: 8, border: '1px solid #eee' }}
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                />
                              )}
                              <button
                                onClick={() => { handleDownload(idx); }}
                                className="bg-purple-600 text-white py-1 px-3 rounded hover:bg-purple-700 text-xs font-semibold flex items-center gap-1"
                              >
                                <Download className="w-4 h-4" />
                                Download
                              </button>
                              <button
                                onClick={() => {
                                  setReceivedFiles((prev) => {
                                    const updated = [...prev];
                                    updated[idx] = null;
                                    return updated;
                                  });
                                  setMetadataList((prev) => {
                                    const updated = [...prev];
                                    updated[idx] = null;
                                    return updated;
                                  });
                                }}
                                className="bg-red-100 text-red-700 py-1 px-2 rounded hover:bg-red-200 text-xs font-semibold"
                              >
                                Remove
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="text-xs text-red-500 font-semibold">Removed</span>
                              <button
                                onClick={() => {
                                  setMetadataList((prev) => {
                                    const updated = [...prev];
                                    updated[idx] = prev[idx];
                                    return updated;
                                  });
                                }}
                                className="bg-gray-200 text-gray-700 py-1 px-2 rounded hover:bg-gray-300 text-xs font-semibold"
                              >
                                Restore
                              </button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="space-y-3">
                <button
                  onClick={async () => {
                    if (!receivedFiles.length) return;
                    const zip = new JSZip();
                    receivedFiles.forEach((file, idx) => {
                      let meta = metadataList[idx];
                      if (!meta && file) meta = getFallbackMeta(file, idx);
                      if (file && meta) {
                        zip.file(meta.name, file);
                      }
                    });
                    const content = await zip.generateAsync({ type: 'blob' });
                    const url = URL.createObjectURL(content);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'fluxdrop-files.zip';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                  }}
                  className="w-full bg-purple-600 text-white py-3 px-6 rounded-lg hover:bg-purple-700 transition-colors font-semibold"
                >
                  Download All as ZIP
                </button>
                <button
                  onClick={reset}
                  className="w-full bg-white border border-gray-300 text-gray-700 py-3 px-6 rounded-lg hover:bg-gray-50 transition-colors font-semibold"
                >
                  Receive More Files
                </button>
              </div>
            </div>
          )}

          {/* Debug UI removed */}
        </div>
      </main>
    </div>
  );
}