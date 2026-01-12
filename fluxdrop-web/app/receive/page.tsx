// fluxdrop-web/app/receive/page.tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { ArrowLeft, Download, Check } from 'lucide-react';
import Link from 'next/link';
import { SignalingClient } from '@/lib/signaling/SignalingClient';
import { RTCConnection } from '@/lib/webrtc/RTCConnection';
import { FileTransferReceiver, FileMetadata, formatBytes, formatSpeed, formatTime } from '@/lib/transfer/FileTransfer';

type Step = 'enter-code' | 'connecting' | 'receiving' | 'complete';

export default function ReceivePage() {
  const [step, setStep] = useState<Step>('enter-code');
  const [code, setCode] = useState('');
  const [batchMetadata, setBatchMetadata] = useState<FileMetadata[]>([]);
  const [metadataList, setMetadataList] = useState<Array<FileMetadata | null>>([]);
  const [progressList, setProgressList] = useState<number[]>([]);
  const [speedList, setSpeedList] = useState<number[]>([]);
  const [timeRemainingList, setTimeRemainingList] = useState<number[]>([]);
  const [receivedFiles, setReceivedFiles] = useState<Blob[]>([]);
  const [error, setError] = useState('');

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

      // Setup transfer receiver
      const transfer = new FileTransferReceiver();
      transferRef.current = transfer;

      // @ts-ignore: Add missing property for batch metadata event
      transfer.onBatchMetadata = (batch) => {
        // Support both { files } and { batchMetadata: { files } } structures
        const files = (batch as any)?.files || (batch as any)?.batchMetadata?.files;
        if (!files) return;
        setBatchMetadata(files);
        setMetadataList(files.map(() => null)); // Pre-fill with nulls for correct indexing
        setProgressList(new Array(files.length).fill(0));
        setSpeedList(new Array(files.length).fill(0));
        setTimeRemainingList(new Array(files.length).fill(0));
        setReceivedFiles(new Array(files.length).fill(null));
      };

      transfer.onMetadata = (meta: FileMetadata) => {
        setMetadataList((prev) => {
          const updated = [...prev];
          updated[fileIndexRef.current] = meta;
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

      transfer.onComplete = (file: Blob, completedFileIndex: number) => {
        setReceivedFiles((prev) => {
          const updated = [...prev];
          updated[completedFileIndex] = file;
          console.log('[ReceivePage] setReceivedFiles:', updated);
          // Always check batchMetadata length and received count
          const totalFiles = batchMetadata.length || 1;
          const receivedCount = updated.filter(Boolean).length;
          if (receivedCount >= totalFiles) {
            console.log('[ReceivePage] All files received, setting step to complete');
            setStep('complete');
          }
          return updated;
        });
        fileIndexRef.current++;
      };

      transfer.onError = (err) => {
        setError(err.message);
      };

      // Handle signaling messages
      signaling.on('session-joined', async () => {
              signaling.on('peer-disconnected', () => {
                console.warn('[ReceivePage] Peer disconnected');
                setError('Sender disconnected. Please try again or receive more files.');
                setStep('enter-code');
                rtcRef.current?.close();
                signalingRef.current?.disconnect();
              });
        console.log('Joined session');
        setStep('receiving');
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
    }
  };

  const handleDownload = (fileIndex: number) => {
    if (!receivedFiles[fileIndex] || !metadataList[fileIndex]) return;
    const url = URL.createObjectURL(receivedFiles[fileIndex]);
    const a = document.createElement('a');
    a.href = url;
    a.download = metadataList[fileIndex].name;
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
              <div className="bg-gray-50 rounded-lg p-4 mb-6">
                <ul className="space-y-2">
                  {metadataList.map((meta, idx) => (
                    meta && receivedFiles[idx] ? (
                      <li key={meta.name + meta.size} className="flex justify-between items-center">
                        <span className="font-semibold text-gray-900">{meta.name}</span>
                        <span className="text-sm text-gray-600">{formatBytes(meta.size)}</span>
                        <button
                          onClick={() => { console.log('[ReceivePage] Download clicked for', idx, receivedFiles[idx]); handleDownload(idx); }}
                          className="ml-4 bg-purple-600 text-white py-1 px-3 rounded hover:bg-purple-700 text-xs font-semibold flex items-center gap-1"
                        >
                          <Download className="w-4 h-4" />
                          Download
                        </button>
                        <button
                          onClick={() => {
                            setReceivedFiles((prev) => prev.filter((_, i) => i !== idx));
                            setMetadataList((prev) => prev.filter((_, i) => i !== idx));
                          }}
                          className="ml-2 bg-red-100 text-red-700 py-1 px-2 rounded hover:bg-red-200 text-xs font-semibold"
                        >
                          Remove
                        </button>
                      </li>
                    ) : (
                      <li key={idx} className="flex justify-between items-center opacity-50">
                        <span className="font-semibold text-gray-400">File not ready</span>
                      </li>
                    )
                  ))}
                </ul>
              </div>
              <div className="space-y-3">
                <button
                  onClick={async () => {
                    if (!receivedFiles.length) return;
                    const zip = new JSZip();
                    receivedFiles.forEach((file, idx) => {
                      const meta = metadataList[idx];
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
        </div>
      </main>
    </div>
  );
}