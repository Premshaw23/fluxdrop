// fluxdrop-web/app/receive/page.tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Download, Check } from 'lucide-react';
import Link from 'next/link';
import { SignalingClient } from '@/lib/signaling/SignalingClient';
import { RTCConnection } from '@/lib/webrtc/RTCConnection';
import { FileTransferReceiver, FileMetadata, formatBytes, formatSpeed, formatTime } from '@/lib/transfer/FileTransfer';

type Step = 'enter-code' | 'connecting' | 'receiving' | 'complete';

export default function ReceivePage() {
  const [step, setStep] = useState<Step>('enter-code');
  const [code, setCode] = useState('');
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [receivedFile, setReceivedFile] = useState<Blob | null>(null);
  const [error, setError] = useState('');

  const signalingRef = useRef<SignalingClient | null>(null);
  const rtcRef = useRef<RTCConnection | null>(null);
  const transferRef = useRef<FileTransferReceiver | null>(null);

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

      transfer.onMetadata = (meta) => {
        setMetadata(meta);
        setStep('receiving');
      };

      transfer.onProgress = (prog) => {
        setProgress(prog.percentage);
        setSpeed(prog.speed);
        setTimeRemaining(prog.timeRemaining);
      };

      transfer.onComplete = (file) => {
        setReceivedFile(file);
        setStep('complete');
        setProgress(100);
      };

      transfer.onError = (err) => {
        setError(err.message);
      };

      // Handle signaling messages
      signaling.on('session-joined', async () => {
        console.log('Joined session');
      });

      signaling.on('offer', async (message) => {
        await rtc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        const answer = await rtc.createAnswer();
        signaling.sendAnswer(answer.sdp!);
      });

      signaling.on('ice-candidate', async (message) => {
        await rtc.addIceCandidate(message.candidate);
      });

      signaling.on('error', (message) => {
        setError(message.error);
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

  const handleDownload = () => {
    if (!receivedFile || !metadata) return;

    const url = URL.createObjectURL(receivedFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = metadata.name;
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
    setMetadata(null);
    setProgress(0);
    setReceivedFile(null);
    setError('');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
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
              <h2 className="text-3xl font-bold text-gray-900 mb-6 text-center">Receiving File</h2>

              {metadata && (
                <div className="mb-6">
                  <p className="font-semibold text-gray-900 mb-1">{metadata.name}</p>
                  <p className="text-sm text-gray-600">{formatBytes(metadata.size)}</p>
                </div>
              )}

              {/* Progress Bar */}
              <div className="mb-6">
                <div className="flex justify-between text-sm text-gray-600 mb-2">
                  <span>{Math.round(progress)}%</span>
                  <span>{formatSpeed(speed)}</span>
                </div>
                <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-purple-600 transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="text-center text-sm text-gray-500 mt-2">
                  {timeRemaining > 0 && `${formatTime(timeRemaining)} remaining`}
                </div>
              </div>
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
                <p className="text-gray-600">Your file is ready to download</p>
              </div>

              {metadata && (
                <div className="bg-gray-50 rounded-lg p-4 mb-6">
                  <p className="font-semibold text-gray-900 mb-1">{metadata.name}</p>
                  <p className="text-sm text-gray-600">{formatBytes(metadata.size)}</p>
                </div>
              )}

              <div className="space-y-3">
                <button
                  onClick={handleDownload}
                  className="w-full bg-purple-600 text-white py-3 px-6 rounded-lg hover:bg-purple-700 transition-colors font-semibold flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  Download File
                </button>
                
                <button
                  onClick={reset}
                  className="w-full bg-white border border-gray-300 text-gray-700 py-3 px-6 rounded-lg hover:bg-gray-50 transition-colors font-semibold"
                >
                  Receive Another File
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}