// fluxdrop-web/app/send/page.tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Upload, Copy, Check, Wifi } from 'lucide-react';
import Link from 'next/link';
import { SignalingClient } from '@/lib/signaling/SignalingClient';
import { RTCConnection } from '@/lib/webrtc/RTCConnection';
import { FileTransferSender, formatBytes, formatSpeed, formatTime } from '@/lib/transfer/FileTransfer';

type Step = 'select' | 'waiting' | 'connected' | 'transferring' | 'complete';

export default function SendPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('select');
  const [file, setFile] = useState<File | null>(null);
  const [sessionCode, setSessionCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [error, setError] = useState('');

  const signalingRef = useRef<SignalingClient | null>(null);
  const rtcRef = useRef<RTCConnection | null>(null);
  const transferRef = useRef<FileTransferSender | null>(null);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      transferRef.current?.cancel();
      rtcRef.current?.close();
      signalingRef.current?.disconnect();
    };
  }, []);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;

    setFile(selectedFile);
    setStep('waiting');
    initializeConnection();
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
          console.log('Connection state:', state);
          if (state === 'connected') {
            setStep('connected');
          } else if (state === 'failed') {
            setError('Connection failed. Please try again.');
          }
        },
        onDataChannelOpen: () => {
          console.log('Data channel ready');
          startTransfer();
        },
        onError: (err) => {
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
        // Create and send offer
        const offer = await rtc.createOffer();
        signaling.sendOffer(offer.sdp!);
      });

      signaling.on('answer', async (message) => {
        await rtc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
      });

      signaling.on('ice-candidate', async (message) => {
        await rtc.addIceCandidate(message.candidate);
      });

      signaling.on('error', (message) => {
        setError(message.error);
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

  const startTransfer = async () => {
    if (!file || !rtcRef.current) return;

    setStep('transferring');

    const transfer = new FileTransferSender(
      (data) => rtcRef.current!.send(data),
      () => rtcRef.current!.getBufferedAmount()
    );
    transferRef.current = transfer;

    transfer.onProgress = (prog) => {
      setProgress(prog.percentage);
      setSpeed(prog.speed);
      setTimeRemaining(prog.timeRemaining);
    };

    transfer.onComplete = () => {
      setStep('complete');
      setProgress(100);
    };

    transfer.onError = (err) => {
      setError(err.message);
    };

    await transfer.startTransfer(file);
  };

  const copyCode = () => {
    navigator.clipboard.writeText(sessionCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const reset = () => {
    transferRef.current?.cancel();
    rtcRef.current?.close();
    signalingRef.current?.disconnect();
    
    setStep('select');
    setFile(null);
    setSessionCode('');
    setProgress(0);
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

          {/* Select File */}
          {step === 'select' && (
            <div className="bg-white rounded-2xl shadow-xl p-8">
              <div className="text-center mb-8">
                <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Upload className="w-10 h-10 text-blue-600" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-2">Send a File</h2>
                <p className="text-gray-600">Choose a file to share instantly</p>
              </div>

              <label className="block">
                <input
                  type="file"
                  onChange={handleFileSelect}
                  className="hidden"
                  id="file-input"
                />
                <div className="border-2 border-dashed border-gray-300 rounded-xl p-12 text-center cursor-pointer hover:border-blue-500 hover:bg-blue-50 transition-colors">
                  <Upload className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-lg text-gray-700 mb-2">Click to select a file</p>
                  <p className="text-sm text-gray-500">Any file up to 2GB</p>
                </div>
              </label>
            </div>
          )}

          {/* Waiting for Receiver */}
          {step === 'waiting' && (
            <div className="bg-white rounded-2xl shadow-xl p-8">
              <div className="text-center mb-8">
                <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
                  <Wifi className="w-10 h-10 text-blue-600" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-2">Share This Code</h2>
                <p className="text-gray-600">Waiting for receiver to join...</p>
              </div>

              {/* File Info */}
              {file && (
                <div className="bg-gray-50 rounded-lg p-4 mb-6">
                  <p className="text-sm text-gray-500 mb-1">Selected file:</p>
                  <p className="font-semibold text-gray-900">{file.name}</p>
                  <p className="text-sm text-gray-600">{formatBytes(file.size)}</p>
                </div>
              )}

              {/* Session Code */}
              <div className="bg-blue-50 rounded-xl p-6 mb-6">
                <p className="text-sm text-gray-600 mb-2 text-center">Transfer Code</p>
                <div className="text-6xl font-bold text-blue-600 text-center tracking-wider mb-4">
                  {sessionCode || '------'}
                </div>
                {sessionCode && (
                  <button
                    onClick={copyCode}
                    className="w-full bg-white border border-blue-200 text-blue-600 py-3 px-4 rounded-lg hover:bg-blue-50 transition-colors flex items-center justify-center gap-2"
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

              <p className="text-center text-sm text-gray-500">
                Code expires in 5 minutes
              </p>
            </div>
          )}

          {/* Connected */}
          {step === 'connected' && (
            <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Check className="w-10 h-10 text-green-600" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-2">Connected!</h2>
              <p className="text-gray-600">Starting transfer...</p>
            </div>
          )}

          {/* Transferring */}
          {step === 'transferring' && (
            <div className="bg-white rounded-2xl shadow-xl p-8">
              <h2 className="text-3xl font-bold text-gray-900 mb-6 text-center">Sending File</h2>

              {file && (
                <div className="mb-6">
                  <p className="font-semibold text-gray-900 mb-1">{file.name}</p>
                  <p className="text-sm text-gray-600">{formatBytes(file.size)}</p>
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
                    className="h-full bg-blue-600 transition-all duration-300"
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
            <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Check className="w-10 h-10 text-green-600" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-2">Transfer Complete!</h2>
              <p className="text-gray-600 mb-6">Your file was sent successfully</p>

              <button
                onClick={reset}
                className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg hover:bg-blue-700 transition-colors font-semibold"
              >
                Send Another File
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}