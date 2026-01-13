// fluxdrop-web/app/receive/page.tsx
'use client';

import { useEffect, useRef, useState } from 'react';

import { useCallback } from 'react';
import QRScanner from './QRScanner';

import JSZip from 'jszip';
import { ArrowLeft, Download, Check } from 'lucide-react';
import Link from 'next/link';
import { SignalingClient } from '@/lib/signaling/SignalingClient';
import { RTCConnection } from '@/lib/webrtc/RTCConnection';
import { FileTransferReceiver, FileMetadata, formatBytes, formatSpeed, formatTime } from '@/lib/transfer/FileTransfer';
import { generateECDHKeyPair, exportPublicKey, importPublicKey, deriveSharedSecret } from '@/lib/crypto/crypto';

type Step = 'enter-code' | 'connecting' | 'receiving' | 'complete';

export default function ReceivePage() {
  // Resume state
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [resumeInProgress, setResumeInProgress] = useState(false);
  // Connection quality/type indicator state
  const [connectionType, setConnectionType] = useState<string>('');
  const [connectionQuality, setConnectionQuality] = useState<string>('');
  const [isOffline, setIsOffline] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
      setIsOffline(!navigator.onLine);
    }
  }, []);
  // ECDH state
  const ecdhKeyPairRef = useRef<{ publicKey: CryptoKey, privateKey: CryptoKey } | null>(null);
  const peerPublicKeyRef = useRef<CryptoKey | null>(null);
  const sharedSecretRef = useRef<CryptoKey | null>(null);
  const [step, setStep] = useState<Step>('enter-code');
  const stepRef = useRef<Step>('enter-code');
  useEffect(() => { stepRef.current = step; }, [step]);
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
  // Track if transfer is complete, for robust error suppression
  const transferCompleteRef = useRef(false);

  // Track if component is mounted to prevent setState after unmount
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Listen for online/offline events
  useEffect(() => {
    const handleOnline = () => { if (isMountedRef.current) setIsOffline(false); };
    const handleOffline = () => { if (isMountedRef.current) setIsOffline(true); };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      // Inform peer of cancel on unmount if connected
      if (signalingRef.current && signalingRef.current.isConnected()) {
        signalingRef.current.send({ type: 'session-cancel' });
      }
      rtcRef.current?.close();
      signalingRef.current?.disconnect();
    };
  }, []);


  useEffect(() => {
    return () => {
      rtcRef.current?.close();
      signalingRef.current?.disconnect();
    };
  }, []);

  // Manual resume handler (move to component scope)
  const handleResume = async () => {
    if (!isMountedRef.current) return;
    setResumeInProgress(true);
    setError('');
    // Try to reconnect and request missing chunks
    try {
      if (!signalingRef.current || !rtcRef.current || !transferRef.current) {
        if (isMountedRef.current) {
          setError('Cannot resume: connection not initialized.');
          setResumeInProgress(false);
        }
        return;
      }
      await signalingRef.current.connect();
      await rtcRef.current.initialize('receiver');
      // Request missing chunks
      transferRef.current.requestMissingChunks((msg) => {
        // Send as ArrayBuffer
        const encoder = new TextEncoder();
        rtcRef.current?.send(encoder.encode(JSON.stringify(msg)));
      });
      if (isMountedRef.current) {
        setResumeInProgress(false);
        setResumeAvailable(false);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError('Resume failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
        setResumeInProgress(false);
      }
    }
  };

  const handleJoinSession = async () => {
    if (code.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }
    setStep('connecting');
    setError('');
    setHandshakeInProgress(true);
    // Always reset transfer state before joining session
    setBatchMetadata([]);
    setMetadataList([]);
    setProgressList([]);
    setSpeedList([]);
    setTimeRemainingList([]);
    setReceivedFiles([]);
    setFileDebugInfo([]);
    fileIndexRef.current = 0;

    try {
      // Connect to signaling server
      const signalingUrl = process.env.NEXT_PUBLIC_SIGNALING_URL || 'ws://localhost:3001';
      const signaling = new SignalingClient(signalingUrl);
      signalingRef.current = signaling;

      await signaling.connect();

      // Initialize WebRTC
      const rtc = new RTCConnection({
        onStateChange: (state) => {
          if (state === 'failed') {
            setError('Connection failed. Please try again.');
          }
        },
        onDataChannelOpen: () => {},
        onMessage: (data) => {
          transferRef.current?.handleMessage(data);
        },
        onError: (err) => {
          // ...existing error logic...
          if (typeof err === 'object' && err !== null) {
            if ('name' in err) console.log('[ReceivePage][DEBUG] err.name:', (err as any).name);
            if ('message' in err) console.log('[ReceivePage][DEBUG] err.message:', (err as any).message);
          }
          const isOpError = (e: unknown): e is { name: string; message?: string } =>
            typeof e === 'object' && e !== null && 'name' in e && typeof (e as any).name === 'string';
          let opError: { name: string; message?: string } | undefined = undefined;
          if (typeof err === 'object' && err !== null && 'name' in err && (err as any).name === 'OperationError') {
            opError = err as any;
          }
          if (err.message === 'Data channel error' || opError) {
            if (stepRef.current === 'complete' || transferCompleteRef.current) {
              if (opError && (opError.message?.includes('User-Initiated Abort') || opError.message?.includes('Close called'))) {
                return;
              }
              if (isMountedRef.current) setError('Warning: Sender disconnected. You can still download your files.');
            } else {
              if (isMountedRef.current) {
                setError('Connection lost. The sender has reset or closed the session. You may be able to resume the transfer.');
                setResumeAvailable(true);
                setResumeInProgress(false);
              }
            }
          } else {
            if (isMountedRef.current) setError(err.message);
          }
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
          fileIndexRef.current = 0 // Reset file index for new batch
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
          console.log(`[ReceivePage] onComplete called for fileIndex=${completedFileIndex}, blob.size=${file.size}`);
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
            console.log(`[ReceivePage] ReceivedCount=${receivedCount}, totalFiles=${totalFiles}`);
            if (receivedCount >= totalFiles) {
              console.log('[ReceivePage] All files received, setting step to complete');
              transferCompleteRef.current = true;
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
          if (isMountedRef.current) setError(err.message);
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
          if (!isMountedRef.current) return;
          if (step === 'complete') {
            setError('Warning: Sender disconnected. You can still download your files.');
          } else {
            setError('Sender disconnected. Please try again or receive more files.');
            setStep('enter-code');
            rtcRef.current?.close();
            signalingRef.current?.disconnect();
            setBatchMetadata([]);
            setMetadataList([]);
            setProgressList([]);
            setSpeedList([]);
            setTimeRemainingList([]);
            setReceivedFiles([]);
            setHandshakeInProgress(false);
            fileIndexRef.current = 0;
          }
        });
        // Listen for session-cancel and session-reset from peer
        signaling.on('session-cancel', () => {
          if (!isMountedRef.current) return;
          if (step === 'complete') {
            setError('Warning: Sender cancelled the session. You can still download your files.');
          } else {
            setError('Sender cancelled the session. Please start a new transfer.');
            setStep('enter-code');
            rtcRef.current?.close();
            signalingRef.current?.disconnect();
            setBatchMetadata([]);
            setMetadataList([]);
            setProgressList([]);
            setSpeedList([]);
            setTimeRemainingList([]);
            setReceivedFiles([]);
            setHandshakeInProgress(false);
            fileIndexRef.current = 0;
          }
        });
        signaling.on('session-reset', () => {
          if (!isMountedRef.current) return;
          if (step === 'complete') {
            setError('Warning: Sender reset the session. You can still download your files.');
          } else {
            setError('Sender reset the session. Please start a new transfer.');
            setStep('enter-code');
            rtcRef.current?.close();
            signalingRef.current?.disconnect();
            setBatchMetadata([]);
            setMetadataList([]);
            setProgressList([]);
            setSpeedList([]);
            setTimeRemainingList([]);
            setReceivedFiles([]);
            setHandshakeInProgress(false);
            fileIndexRef.current = 0;
          }
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
        if (!isMountedRef.current) return;
        if (step === 'complete') {
          setError('Warning: Signaling error after transfer. You can still download your files.');
        } else {
          setError(message.error || 'Session not found or expired. Please check the code and try again.');
          setStep('enter-code');
          rtcRef.current?.close();
          signalingRef.current?.disconnect();
          setBatchMetadata([]);
          setMetadataList([]);
          setProgressList([]);
          setSpeedList([]);
          setTimeRemainingList([]);
          setReceivedFiles([]);
          setHandshakeInProgress(false);
          fileIndexRef.current = 0;
        }
      });

      // Handle ICE candidates
      rtc.onIceCandidate = (candidate) => {
        signaling.sendIceCandidate(candidate);
      };

      // Join session
      signaling.joinSession(code);
    } catch (err) {
      if (!isMountedRef.current) return;
      if (step === 'complete') {
        setError('Warning: Connection error after transfer. You can still download your files.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to connect');
        setStep('enter-code');
        rtcRef.current?.close();
        signalingRef.current?.disconnect();
        setBatchMetadata([]);
        setMetadataList([]);
        setProgressList([]);
        setSpeedList([]);
        setTimeRemainingList([]);
        setReceivedFiles([]);
        setHandshakeInProgress(false);
        fileIndexRef.current = 0;
      }
    }
  };

  // New function: handleJoinSessionWithCode
  const handleJoinSessionWithCode = async (joinCode: string) => {
    if (joinCode.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }
    setStep('connecting');
    setError('');
    setHandshakeInProgress(true);
    setBatchMetadata([]);
    setMetadataList([]);
    setProgressList([]);
    setSpeedList([]);
    setTimeRemainingList([]);
    setReceivedFiles([]);
    setFileDebugInfo([]);
    fileIndexRef.current = 0;

    try {
      const signalingUrl = process.env.NEXT_PUBLIC_SIGNALING_URL || 'ws://localhost:3001';
      const signaling = new SignalingClient(signalingUrl);
      signalingRef.current = signaling;

      await signaling.connect();

      const rtc = new RTCConnection({
        onStateChange: (state) => {
          if (state === 'failed') {
            setError('Connection failed. Please try again.');
          }
        },
        onDataChannelOpen: () => {},
        onMessage: (data) => {
          transferRef.current?.handleMessage(data);
        },
        onError: (err) => {
          if (typeof err === 'object' && err !== null) {
            if ('name' in err) console.log('[ReceivePage][DEBUG] err.name:', (err as any).name);
            if ('message' in err) console.log('[ReceivePage][DEBUG] err.message:', (err as any).message);
          }
          const isOpError = (e: unknown): e is { name: string; message?: string } =>
            typeof e === 'object' && e !== null && 'name' in e && typeof (e as any).name === 'string';
          let opError: { name: string; message?: string } | undefined = undefined;
          if (typeof err === 'object' && err !== null && 'name' in err && (err as any).name === 'OperationError') {
            opError = err as any;
          }
          if (err.message === 'Data channel error' || opError) {
            if (stepRef.current === 'complete' || transferCompleteRef.current) {
              if (opError && (opError.message?.includes('User-Initiated Abort') || opError.message?.includes('Close called'))) {
                return;
              }
              if (isMountedRef.current) setError('Warning: Sender disconnected. You can still download your files.');
            } else {
              if (isMountedRef.current) {
                setError('Connection lost. The sender has reset or closed the session. You may be able to resume the transfer.');
                setResumeAvailable(true);
                setResumeInProgress(false);
              }
            }
          } else {
            if (isMountedRef.current) setError(err.message);
          }
        }
      });
      rtcRef.current = rtc;

      await rtc.initialize('receiver');

      // Register all signaling handlers BEFORE joinSession
      signaling.on('session-joined', async () => {
        const keyPair = await generateECDHKeyPair();
        ecdhKeyPairRef.current = keyPair;
        const exported = await exportPublicKey(keyPair.publicKey);
        const pubKeyB64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
        signaling.sendPublicKey(pubKeyB64);
        console.log('Joined session, public key sent');
        setStep('receiving');
      });
      signaling.on('peer-disconnected', () => {
        console.warn('[ReceivePage] Peer disconnected');
        if (!isMountedRef.current) return;
        if (step === 'complete') {
          setError('Warning: Sender disconnected. You can still download your files.');
        } else {
          setError('Sender disconnected. Please try again or receive more files.');
          setStep('enter-code');
          rtcRef.current?.close();
          signalingRef.current?.disconnect();
          setBatchMetadata([]);
          setMetadataList([]);
          setProgressList([]);
          setSpeedList([]);
          setTimeRemainingList([]);
          setReceivedFiles([]);
          setHandshakeInProgress(false);
          fileIndexRef.current = 0;
        }
      });
      signaling.on('session-cancel', () => {
        if (!isMountedRef.current) return;
        if (step === 'complete') {
          setError('Warning: Sender cancelled the session. You can still download your files.');
        } else {
          setError('Sender cancelled the session. Please start a new transfer.');
          setStep('enter-code');
          rtcRef.current?.close();
          signalingRef.current?.disconnect();
          setBatchMetadata([]);
          setMetadataList([]);
          setProgressList([]);
          setSpeedList([]);
          setTimeRemainingList([]);
          setReceivedFiles([]);
          setHandshakeInProgress(false);
          fileIndexRef.current = 0;
        }
      });
      signaling.on('session-reset', () => {
        if (!isMountedRef.current) return;
        if (step === 'complete') {
          setError('Warning: Sender reset the session. You can still download your files.');
        } else {
          setError('Sender reset the session. Please start a new transfer.');
          setStep('enter-code');
          rtcRef.current?.close();
          signalingRef.current?.disconnect();
          setBatchMetadata([]);
          setMetadataList([]);
          setProgressList([]);
          setSpeedList([]);
          setTimeRemainingList([]);
          setReceivedFiles([]);
          setHandshakeInProgress(false);
          fileIndexRef.current = 0;
        }
      });
      signaling.on('public-key', async (message) => {
        const raw = Uint8Array.from(atob(message.publicKey), c => c.charCodeAt(0));
        const peerKey = await importPublicKey(raw.buffer);
        peerPublicKeyRef.current = peerKey;
        if (ecdhKeyPairRef.current) {
          sharedSecretRef.current = await deriveSharedSecret(ecdhKeyPairRef.current.privateKey, peerKey);
          console.log('[ReceivePage] Shared secret derived');
        }
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
        if (!isMountedRef.current) return;
        if (step === 'complete') {
          setError('Warning: Signaling error after transfer. You can still download your files.');
        } else {
          setError(message.error || 'Session not found or expired. Please check the code and try again.');
          setStep('enter-code');
          rtcRef.current?.close();
          signalingRef.current?.disconnect();
          setBatchMetadata([]);
          setMetadataList([]);
          setProgressList([]);
          setSpeedList([]);
          setTimeRemainingList([]);
          setReceivedFiles([]);
          setHandshakeInProgress(false);
          fileIndexRef.current = 0;
        }
      });
      rtc.onIceCandidate = (candidate) => {
        signaling.sendIceCandidate(candidate);
      };

      // Handshake polling with timeout
      let attempts = 0;
      const maxAttempts = 100; // 5 seconds
      const setupTransferReceiver = () => {
        if (!sharedSecretRef.current) {
          setError('Encryption handshake not complete. Please wait for the connection to establish before receiving files.');
          console.error('[ReceivePage] Cannot start receiving: shared secret not set.');
          return;
        }
        let transfer = new FileTransferReceiver();
        transfer.setDecryptionKey(sharedSecretRef.current);
        transferRef.current = transfer;
        transfer.onBatchMetadata = (batch) => {
          const files = (batch as any)?.files || (batch as any)?.batchMetadata?.files;
          if (!files) return;
          setBatchMetadata((prev) => (prev.length === 0 ? files : prev));
          setMetadataList(files.map(() => null));
          setProgressList(new Array(files.length).fill(0));
          setSpeedList(new Array(files.length).fill(0));
          setTimeRemainingList(new Array(files.length).fill(0));
          setReceivedFiles(new Array(files.length).fill(null));
          fileIndexRef.current = 0;
        };
        transfer.onMetadata = (meta: FileMetadata) => {
          setMetadataList((prev) => {
            const updated = [...prev];
            let idx = batchMetadata.findIndex(
              (m) => m.name === meta.name && m.size === meta.size && m.type === meta.type
            );
            if (idx === -1) idx = updated.findIndex((m) => m === null);
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
            const totalFiles = batchMetadata.length || 1;
            const receivedCount = updated.filter(Boolean).length;
            if (receivedCount >= totalFiles) {
              transferCompleteRef.current = true;
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
          if (isMountedRef.current) setError(err.message);
          ecdhKeyPairRef.current = null;
          peerPublicKeyRef.current = null;
          sharedSecretRef.current = null;
        };
      };
      const waitForSharedSecret = () => {
        if (sharedSecretRef.current) {
          setHandshakeInProgress(false);
          setupTransferReceiver();
        } else if (attempts++ < maxAttempts) {
          setTimeout(waitForSharedSecret, 50);
        } else {
          setError('Handshake timeout. Please try again.');
          setStep('enter-code');
          setHandshakeInProgress(false);
        }
      };
      waitForSharedSecret();

      signaling.joinSession(joinCode);
    } catch (err) {
      if (!isMountedRef.current) return;
      if (step === 'complete') {
        setError('Warning: Connection error after transfer. You can still download your files.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to connect');
        setStep('enter-code');
        rtcRef.current?.close();
        signalingRef.current?.disconnect();
        setBatchMetadata([]);
        setMetadataList([]);
        setProgressList([]);
        setSpeedList([]);
        setTimeRemainingList([]);
        setReceivedFiles([]);
        setHandshakeInProgress(false);
        fileIndexRef.current = 0;
      }
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
    // Inform peer of reset if connected
    if (signalingRef.current && signalingRef.current.isConnected()) {
      signalingRef.current.send({ type: 'session-reset' });
    }
    rtcRef.current?.close();
    signalingRef.current?.disconnect();
    transferRef.current?.reset();
    setStep('enter-code');
    // setCode(''); // Do not clear code on reset
    setBatchMetadata([]);
    setMetadataList([]);
    setProgressList([]);
    setSpeedList([]);
    setTimeRemainingList([]);
    setReceivedFiles([]);
    setFileDebugInfo([]);
    fileIndexRef.current = 0;
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-blue-50 via-white to-purple-50">
      {/* Header */}
      <header className="border-b bg-white/50 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <Link href="/" className="inline-flex items-center gap-2 text-gray-700 hover:text-gray-900">
            <ArrowLeft className="w-5 h-5" />
            <span>Back</span>
          </Link>
          {/* Connection Quality/Type Indicator */}
          <div className="flex items-center gap-2">
            {isOffline ? (
              <span className="text-red-600 font-semibold flex items-center gap-1"><svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636A9 9 0 003.515 20.485m2.121-2.121A5.978 5.978 0 0112 18c1.657 0 3.156-.672 4.243-1.757m2.121-2.121A8.963 8.963 0 0021 12c0-2.485-1.007-4.735-2.636-6.364" /></svg>Offline</span>
            ) : connectionType ? (
              <span className="text-xs px-2 py-1 rounded bg-gray-100 border border-gray-200 text-gray-700 font-semibold flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636A9 9 0 003.515 20.485m2.121-2.121A5.978 5.978 0 0112 18c1.657 0 3.156-.672 4.243-1.757m2.121-2.121A8.963 8.963 0 0021 12c0-2.485-1.007-4.735-2.636-6.364" /></svg>
                {connectionType} <span className={
                  connectionQuality === 'good' ? 'text-green-600' :
                  connectionQuality === 'fair' ? 'text-yellow-600' :
                  connectionQuality === 'poor' ? 'text-red-600' : ''
                }>{connectionQuality}</span>
              </span>
            ) : null}
          </div>
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
          {/* Resume Prompt */}
          {resumeAvailable && (
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 flex flex-col items-center">
              <div className="font-semibold mb-2">Transfer interrupted</div>
              <div className="mb-2">You can try to resume the transfer and request missing chunks.</div>
              <button
                onClick={handleResume}
                disabled={resumeInProgress}
                className="bg-yellow-600 text-white px-4 py-2 rounded hover:bg-yellow-700 font-semibold disabled:opacity-50"
              >
                {resumeInProgress ? 'Resuming...' : 'Resume Transfer'}
              </button>
            </div>
          )}

          {/* Enter Code or Scan QR */}
          {step === 'enter-code' && (
            <div className="bg-white rounded-2xl shadow-xl p-8">
              <div className="text-center mb-8">
                <div className="w-20 h-20 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Download className="w-10 h-10 text-purple-600" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-2">Receive a File</h2>
                <p className="text-gray-600">Enter the 6-digit code from the sender or scan QR</p>
              </div>

              <div className="mb-6 flex flex-col gap-4 items-center">
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
                <ScanQrSection
                  code={code}
                  setCode={setCode}
                  onConnect={handleJoinSessionWithCode}
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
                                  loading="lazy"
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


function ScanQrSection({ code, setCode, onConnect }: { code: string, setCode: (c: string) => void, onConnect: (scannedCode: string) => void }) {
  const [showScanner, setShowScanner] = useState(false);
  const handleResult = useCallback((text: string) => {
    // Try to extract code from URL or plain code
    let match = text.match(/code=([A-Z0-9]{6})/i);
    let found = match ? match[1] : text.match(/[A-Z0-9]{6}/i)?.[0];
    if (found) {
      const scanned = found.toUpperCase();
      setCode(scanned);
      setShowScanner(false);
      if (scanned.length === 6) {
        onConnect(scanned);
      }
    }
  }, [setCode, onConnect]);
  return (
    <div className="w-full flex flex-col items-center">
      <button
        type="button"
        className="mt-2 mb-2 px-4 py-3 bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200 font-semibold w-full max-w-xs text-base sm:text-lg touch-manipulation"
        style={{ minHeight: 48 }}
        onClick={() => setShowScanner((v) => !v)}
      >
        {showScanner ? 'Close QR Scanner' : 'Scan QR Code'}
      </button>
      {showScanner && (
        <div className="w-full flex flex-col items-center">
          <div className="w-full max-w-xs aspect-square rounded-lg overflow-hidden border border-purple-200 bg-black">
            <QRScanner onResult={handleResult} />
          </div>
          <div className="text-xs text-gray-500 mt-2">Point your camera at the sender's QR code</div>
        </div>
      )}
    </div>
  );
}