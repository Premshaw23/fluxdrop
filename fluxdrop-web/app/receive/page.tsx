"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
const QRScanner = dynamic(() => import("./QRScanner"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-40 flex items-center justify-center text-gray-400">
      Loading scanner…
    </div>
  ),
});

import JSZip from "jszip";
import { ArrowLeft, Download, Check, Wifi, Monitor } from "lucide-react";
import Link from "next/link";
import NearbyDevices from "@/components/NearbyDevices";
import { SignalingClient } from "@/lib/signaling/SignalingClient";
import UserIdentityDisplay from "@/components/UserIdentityDisplay";
import { useUserStore } from "@/lib/store";
import { RTCConnection } from "@/lib/webrtc/RTCConnection";
import {
  FileTransferReceiver,
  FileMetadata,
  formatBytes,
  formatSpeed,
  formatTime,
} from "@/lib/transfer/FileTransfer";
import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedSecret,
} from "@/lib/crypto/crypto";
import { useDiscovery } from "@/hooks/useDiscovery";
import QRScannerModal from "./QRScanner";

type Step = "enter-code" | "connecting" | "receiving" | "complete";

export default function ReceivePage() {
  // State management
  const [step, setStep] = useState<Step>("enter-code");
  const stepRef = useRef<Step>("enter-code");
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  const [code, setCode] = useState("");
  const [batchMetadata, setBatchMetadata] = useState<FileMetadata[]>([]);
  const [metadataList, setMetadataList] = useState<(FileMetadata | null)[]>([]);
  const [progressList, setProgressList] = useState<number[]>([]);
  const [speedList, setSpeedList] = useState<number[]>([]);
  const [timeRemainingList, setTimeRemainingList] = useState<number[]>([]);
  const [receivedFiles, setReceivedFiles] = useState<(Blob | null)[]>([]);
  const [error, setError] = useState("");
  const [handshakeInProgress, setHandshakeInProgress] = useState(false);
  const [fileDebugInfo, setFileDebugInfo] = useState<
    Array<{ hash?: string; type?: string; size?: number; hex?: string }>
  >([]);

  // Connection state
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [resumeInProgress, setResumeInProgress] = useState(false);
  const [connectionType, setConnectionType] = useState<string>("");
  const [connectionQuality, setConnectionQuality] = useState<string>("");
  const [isOffline, setIsOffline] = useState<boolean>(false);

  // ECDH state
  const ecdhKeyPairRef = useRef<{
    publicKey: CryptoKey;
    privateKey: CryptoKey;
  } | null>(null);
  const peerPublicKeyRef = useRef<CryptoKey | null>(null);
  const sharedSecretRef = useRef<CryptoKey | null>(null);

  // Refs
  const signalingRef = useRef<SignalingClient | null>(null);
  const rtcRef = useRef<RTCConnection | null>(null);
  const transferRef = useRef<FileTransferReceiver | null>(null);
  const fileIndexRef = useRef(0);

  // CRITICAL FIX: Track if transfer completed successfully
  const transferCompleteRef = useRef(false);
  const filesReadyForDownloadRef = useRef(false);

  // Track if component is mounted
  const isMountedRef = useRef(true);

  // Discovery State
  const [signalingClient, setSignalingClient] = useState<SignalingClient | null>(null);
  const { name, ensureName } = useUserStore();

  // Ensure we have a name
  useEffect(() => {
    ensureName();
  }, [ensureName]);

  const { peers } = useDiscovery({
    signaling: signalingClient,
    deviceName: name || "FluxDrop Receiver",
    deviceType: "receiver"
  });

  // Initialize mounted state & Auto-connect for discovery
  useEffect(() => {
    isMountedRef.current = true;
    if (typeof window !== "undefined" && typeof navigator !== "undefined") {
      setIsOffline(!navigator.onLine);
    }

    // Auto-connect to signaling for discovery
    const signalingUrl = process.env.NEXT_PUBLIC_SIGNALING_URL || "ws://localhost:3001";
    const client = new SignalingClient(signalingUrl);

    client.connect().then(() => {
      if (isMountedRef.current) {
        setSignalingClient(client);
        signalingRef.current = client; // Keep ref for existing logic
      }
    }).catch(err => console.error("Auto-connect failed:", err));

    // Listen for Invites
    client.on('discovery:invite', (message: any) => {
      if (isMountedRef.current && stepRef.current === 'enter-code') {
        // Use a native confirm or custom UI. For MVp, native confirm.
        // "User X wants to send you files. Accept?"
        // Actually, lets just Auto-Join if it matches our expectation or show a toast?
        // Better: Auto-fill code and join.
        console.log(`📨 Received invite from ${message.senderName} with code ${message.code}`);
        setCode(message.code);
        handleJoinSession(message.code);
      }
    });

    return () => {
      isMountedRef.current = false;
      // Don't disconnect here if we are transitioning to transfer? 
      // Actually existing logic handles disconnects.
      // We should probably leave it open.
    };
  }, []); // Run once

  // Online/offline listeners
  useEffect(() => {
    const handleOnline = () => {
      if (isMountedRef.current) setIsOffline(false);
    };
    const handleOffline = () => {
      if (isMountedRef.current) setIsOffline(true);
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Cleanup on unmount - ONLY if transfer not complete
  useEffect(() => {
    return () => {
      // CRITICAL FIX: Only cleanup if files are NOT ready for download
      if (!filesReadyForDownloadRef.current) {
        if (signalingRef.current?.isConnected()) {
          signalingRef.current.send({ type: "session-cancel" });
        }
        rtcRef.current?.close();
        signalingRef.current?.disconnect();
      }
    };
  }, []);

  // CRITICAL FIX: Safe disconnect handler
  const handlePeerDisconnect = useCallback(() => {
    console.warn("[ReceivePage] Peer disconnected");
    if (!isMountedRef.current) return;

    // CRITICAL: If files are already received, just show warning
    if (
      transferCompleteRef.current ||
      filesReadyForDownloadRef.current ||
      stepRef.current === "complete"
    ) {
      setError(
        "Sender disconnected. Your files are safe and ready to download."
      );
      // Don't reset the page or clear files!
      return;
    }

    // Only reset if transfer was incomplete
    setError("Sender disconnected during transfer. Please try again.");
    setResumeAvailable(true);
  }, []);

  // Manual resume handler
  const handleResume = async () => {
    if (!isMountedRef.current) return;
    setResumeInProgress(true);
    setError("");

    try {
      if (!signalingRef.current || !rtcRef.current || !transferRef.current) {
        if (isMountedRef.current) {
          setError("Cannot resume: connection not initialized.");
          setResumeInProgress(false);
        }
        return;
      }

      await signalingRef.current.connect();
      await rtcRef.current.initialize("receiver");

      // transferRef.current.requestMissingChunks((msg) => {
      //   const encoder = new TextEncoder();
      //   rtcRef.current?.send(encoder.encode(JSON.stringify(msg)));
      // });

      if (isMountedRef.current) {
        setResumeInProgress(false);
        setResumeAvailable(false);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(
          "Resume failed: " +
          (err instanceof Error ? err.message : "Unknown error")
        );
        setResumeInProgress(false);
      }
    }
  };

  // CONSOLIDATED: Single join session function
  const handleJoinSession = async (joinCode?: string) => {
    const sessionCode = joinCode || code;

    if (sessionCode.length !== 6) {
      setError("Please enter a 6-digit code");
      return;
    }

    // Reset state
    setStep("connecting");
    setError("");
    setHandshakeInProgress(true);
    setBatchMetadata([]);
    setMetadataList([]);
    setProgressList([]);
    setSpeedList([]);
    setTimeRemainingList([]);
    setReceivedFiles([]);
    setFileDebugInfo([]);
    fileIndexRef.current = 0;
    transferCompleteRef.current = false;
    filesReadyForDownloadRef.current = false;

    try {
      const signalingUrl =
        process.env.NEXT_PUBLIC_SIGNALING_URL || "ws://localhost:3001";
      const signaling = new SignalingClient(signalingUrl);
      signalingRef.current = signaling;

      await signaling.connect();

      // Initialize WebRTC
      const rtc = new RTCConnection({
        onStateChange: (state) => {
          if (state === "failed" && !transferCompleteRef.current) {
            setError("Connection failed. Please try again.");
          }
        },
        onDataChannelOpen: () => { },
        onMessage: (data) => {
          transferRef.current?.handleMessage(data);
        },
        onError: (err) => {
          // CRITICAL FIX: Don't show errors if transfer is complete
          if (transferCompleteRef.current || filesReadyForDownloadRef.current) {
            console.log(
              "[ReceivePage] Ignoring error after transfer complete:",
              err
            );
            return;
          }

          if (err.message === "Data channel error") {
            if (isMountedRef.current) {
              setError(
                "Connection lost. You may be able to resume the transfer."
              );
              setResumeAvailable(true);
            }
          } else {
            if (isMountedRef.current) setError(err.message);
          }
        },
      });
      rtcRef.current = rtc;

      await rtc.initialize("receiver");

      // Setup transfer receiver after handshake
      const setupTransferReceiver = () => {
        if (!sharedSecretRef.current) {
          console.error(
            "[ReceivePage] Cannot setup transfer: no shared secret"
          );
          return;
        }

        const transfer = new FileTransferReceiver();
        transfer.setDecryptionKey(sharedSecretRef.current);
        transferRef.current = transfer;

        // ✅ NEW: Setup callback to send binary data (for acks)
        transfer.setSendData((data) => {
          console.log(
            `[ReceivePage] Sending control message, bytes: ${data.byteLength}`
          );
          return rtcRef.current?.send(data) ?? false;
        });

        // Batch metadata handler
        transfer.onBatchMetadata = (batch) => {
          const files =
            (batch as any)?.files || (batch as any)?.batchMetadata?.files;
          console.log("[ReceivePage] onBatchMetadata:", files);

          if (!files) return;

          setBatchMetadata(files);
          setMetadataList(files.map(() => null));
          setProgressList(new Array(files.length).fill(0));
          setSpeedList(new Array(files.length).fill(0));
          setTimeRemainingList(new Array(files.length).fill(0));
          setReceivedFiles(new Array(files.length).fill(null));
          fileIndexRef.current = 0;
        };

        // Individual file metadata
        transfer.onMetadata = (meta: FileMetadata) => {
          setMetadataList((prev) => {
            const updated = [...prev];
            let idx = batchMetadata.findIndex(
              (m) =>
                m.name === meta.name &&
                m.size === meta.size &&
                m.type === meta.type
            );
            if (idx === -1) idx = updated.findIndex((m) => m === null);
            if (idx === -1) idx = fileIndexRef.current;
            updated[idx] = meta;
            return updated;
          });
          setStep("receiving");
        };

        // Key fix in ReceivePage.tsx

        // In the setupTransferReceiver function, update the onProgress handler:

        // ✅ FIXED: Progress updates now use fileIndex from progress object
        transfer.onProgress = (prog: any) => {
          // Use fileIndex from progress if available, otherwise fall back to fileIndexRef
          const idx =
            prog.fileIndex !== undefined
              ? prog.fileIndex
              : fileIndexRef.current;

          console.log(
            `[ReceivePage] Progress for file ${idx}: ${prog.percentage.toFixed(
              1
            )}%`
          );

          setProgressList((prev) => {
            const updated = [...prev];
            updated[idx] = prog.percentage;
            return updated;
          });

          setSpeedList((prev) => {
            const updated = [...prev];
            updated[idx] = prog.speed;
            return updated;
          });

          setTimeRemainingList((prev) => {
            const updated = [...prev];
            updated[idx] = prog.timeRemaining;
            return updated;
          });
        };

        // Also update the file complete handler to properly track the current file:
        transfer.onComplete = async (
          file: Blob,
          completedFileIndex: number
        ) => {
          console.log(
            `[ReceivePage] File ${completedFileIndex} complete, size: ${file.size}`
          );

          // Calculate hash for debugging
          const arrayBuffer = await file.arrayBuffer();
          const hashBuffer = await window.crypto.subtle.digest(
            "SHA-256",
            arrayBuffer
          );
          const hashB64 = btoa(
            String.fromCharCode(...new Uint8Array(hashBuffer))
          );
          const hex = Array.from(new Uint8Array(arrayBuffer).slice(0, 16))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ");

          setFileDebugInfo((prev) => {
            const updated = [...prev];
            updated[completedFileIndex] = {
              hash: hashB64,
              type: file.type,
              size: file.size,
              hex,
            };
            return updated;
          });

          // Ensure metadata is set
          setMetadataList((prev) => {
            const updated = [...prev];
            if (
              !updated[completedFileIndex] &&
              batchMetadata[completedFileIndex]
            ) {
              updated[completedFileIndex] = batchMetadata[completedFileIndex];
            }
            return updated;
          });

          // ✅ FIX: Update fileIndexRef BEFORE setting received files
          // This ensures the next file's progress goes to the right index
          fileIndexRef.current = completedFileIndex + 1;

          // Add file to received files and check completion
          setReceivedFiles((prev) => {
            const updated = [...prev];
            updated[completedFileIndex] = file;

            const totalFiles = batchMetadata.length || 1;
            const receivedCount = updated.filter(Boolean).length;

            console.log(
              `[ReceivePage] Received ${receivedCount}/${totalFiles} files`
            );

            // CRITICAL FIX: Only mark as complete when ALL files received
            if (receivedCount >= totalFiles && totalFiles > 0) {
              console.log("[ReceivePage] All files received!");
              transferCompleteRef.current = true;
              filesReadyForDownloadRef.current = true;

              // Use setTimeout to ensure state updates are processed
              setTimeout(() => {
                if (isMountedRef.current) {
                  setStep("complete");
                }
              }, 100);

              // Clear encryption keys
              ecdhKeyPairRef.current = null;
              peerPublicKeyRef.current = null;
              sharedSecretRef.current = null;
            } else {
              // Still receiving files - stay in receiving state
              console.log(
                `[ReceivePage] Still waiting for ${totalFiles - receivedCount
                } more files`
              );
            }

            return updated;
          });
          //   fileIndexRef.current++;
        };

        // Transfer error
        transfer.onError = (err) => {
          if (transferCompleteRef.current) return;
          if (isMountedRef.current) setError(err.message);
        };
      };

      // Wait for shared secret with timeout
      let attempts = 0;
      const maxAttempts = 100; // 5 seconds
      const waitForSharedSecret = () => {
        if (sharedSecretRef.current) {
          setHandshakeInProgress(false);
          setupTransferReceiver();
        } else if (attempts++ < maxAttempts) {
          setTimeout(waitForSharedSecret, 50);
        } else {
          setError("Handshake timeout. Please try again.");
          setStep("enter-code");
          setHandshakeInProgress(false);
        }
      };

      // Register signaling event handlers ONCE
      signaling.on("session-joined", async () => {
        console.log("[ReceivePage] Session joined");

        // Generate ECDH key pair
        const keyPair = await generateECDHKeyPair();
        ecdhKeyPairRef.current = keyPair;
        const exported = await exportPublicKey(keyPair.publicKey);
        const pubKeyB64 = btoa(
          String.fromCharCode(...new Uint8Array(exported))
        );
        signaling.sendPublicKey(pubKeyB64);

        setStep("receiving");
      });

      signaling.on("public-key", async (message) => {
        console.log("[ReceivePage] Received peer public key");
        const raw = Uint8Array.from(atob(message.publicKey), (c) =>
          c.charCodeAt(0)
        );
        const peerKey = await importPublicKey(raw.buffer);
        peerPublicKeyRef.current = peerKey;

        if (ecdhKeyPairRef.current) {
          sharedSecretRef.current = await deriveSharedSecret(
            ecdhKeyPairRef.current.privateKey,
            peerKey
          );
          console.log("[ReceivePage] Shared secret derived");
        }
      });

      signaling.on("offer", async (message) => {
        await rtc.setRemoteDescription({ type: "offer", sdp: message.sdp });
        const answer = await rtc.createAnswer();
        signaling.sendAnswer(answer.sdp!);
      });

      signaling.on("ice-candidate", async (message) => {
        await rtc.addIceCandidate(message.candidate);
      });

      // CRITICAL FIX: Better disconnect handling
      signaling.on("peer-disconnected", handlePeerDisconnect);
      signaling.on("session-cancel", handlePeerDisconnect);
      signaling.on("session-reset", handlePeerDisconnect);

      signaling.on("error", (message) => {
        if (!isMountedRef.current) return;

        // CRITICAL FIX: Don't reset if files are ready
        if (transferCompleteRef.current || filesReadyForDownloadRef.current) {
          setError(
            "Connection error, but your files are safe and ready to download."
          );
          return;
        }

        setError(message.error || "Session error. Please try again.");
        setStep("enter-code");
        setHandshakeInProgress(false);
      });

      // ICE candidate handler
      rtc.onIceCandidate = (candidate) => {
        signaling.sendIceCandidate(candidate);
      };

      // Start handshake polling
      waitForSharedSecret();

      // Join session
      signaling.joinSession(sessionCode);
    } catch (err) {
      if (!isMountedRef.current) return;

      if (transferCompleteRef.current || filesReadyForDownloadRef.current) {
        setError("Connection error, but your files are safe.");
        return;
      }

      setError(err instanceof Error ? err.message : "Failed to connect");
      setStep("enter-code");
      setHandshakeInProgress(false);
    }
  };

  // Download handler
  const handleDownload = (fileIndex: number) => {
    const file = receivedFiles[fileIndex];
    const meta = metadataList[fileIndex] || batchMetadata[fileIndex];

    if (!file || !meta) return;

    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = meta.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Download completed files as ZIP
  const handleDownloadCompleted = async () => {
    const completedFiles = receivedFiles
      .map((file, idx) => ({ file, idx }))
      .filter(({ file }) => file !== null);

    if (completedFiles.length === 0) return;

    if (completedFiles.length === 1) {
      handleDownload(completedFiles[0].idx);
      return;
    }

    const zip = new JSZip();
    completedFiles.forEach(({ file, idx }) => {
      const meta = metadataList[idx] || batchMetadata[idx];
      if (file && meta) {
        zip.file(meta.name, file);
      }
    });

    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fluxdrop-files.zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Reset for new transfer
  const reset = () => {
    // CRITICAL FIX: Clean disconnect
    if (signalingRef.current?.isConnected()) {
      signalingRef.current.send({ type: "session-reset" });
    }

    // Only close connections if transfer is not in progress
    if (transferCompleteRef.current || !transferRef.current) {
      rtcRef.current?.close();
      signalingRef.current?.disconnect();
    }

    // Reset all state
    setStep("enter-code");
    setBatchMetadata([]);
    setMetadataList([]);
    setProgressList([]);
    setSpeedList([]);
    setTimeRemainingList([]);
    setReceivedFiles([]);
    setFileDebugInfo([]);
    setError("");
    setHandshakeInProgress(false);
    fileIndexRef.current = 0;
    transferCompleteRef.current = false;
    filesReadyForDownloadRef.current = false;
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-white via-blue-50 to-purple-50">
      <style jsx>{`
        @keyframes bounce-once {
          0%,
          100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-10px);
          }
        }
        .animate-bounce-once {
          animation: bounce-once 0.6s ease-in-out;
        }
      `}</style>

      <header className="border-b bg-white/60 backdrop-blur-md shadow-sm sticky top-0 z-20">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-purple-900 hover:text-purple-700 font-semibold transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            <span>Back</span>
          </Link>
          {isOffline && (
            <span className="text-red-600 font-semibold text-sm animate-pulse flex items-center gap-1">
              <Wifi className="w-4 h-4" />
              Offline
            </span>
          )}
          <div className="hidden sm:block">
            <UserIdentityDisplay />
          </div>
        </div>
      </header>

      {handshakeInProgress && (
        <div className="flex flex-col items-center justify-center mt-8 animate-fade-in">
          <div className="relative w-16 h-16 mb-4">
            <div className="absolute inset-0 bg-purple-100 rounded-full animate-ping opacity-25"></div>
            <div className="relative w-16 h-16 bg-purple-50 rounded-full flex items-center justify-center border-2 border-purple-200">
              <div className="w-8 h-8 border-3 border-purple-200 border-t-purple-600 animate-spin rounded-full"></div>
            </div>
          </div>
          <p className="text-purple-700 font-bold text-lg">
            Establishing secure connection...
          </p>
          <p className="text-purple-400 text-sm">Almost there</p>
        </div>
      )}

      <main className="container mx-auto px-4 py-12 sm:py-16">
        <div className="max-w-2xl mx-auto">
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 shadow-lg animate-shake flex items-center gap-3">
              <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center shrink-0">
                <span className="font-bold">!</span>
              </div>
              <div className="font-bold text-base flex-1">{error}</div>
            </div>
          )}

          {resumeAvailable && (
            <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4 animate-fade-in">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
                  <Wifi className="w-5 h-5 text-amber-600" />
                </div>
                <p className="font-bold text-amber-900">Transfer interrupted</p>
              </div>
              <button
                onClick={handleResume}
                disabled={resumeInProgress}
                className="w-full sm:w-auto bg-amber-500 text-white px-6 py-2.5 rounded-xl hover:bg-amber-600 disabled:bg-amber-100 disabled:text-amber-300 transition-all font-bold shadow-md"
              >
                {resumeInProgress ? "Resuming..." : "Resume Transfer"}
              </button>
            </div>
          )}

          {step === "enter-code" && (
            <div className="bg-white/80 backdrop-blur-xl rounded-2xl sm:rounded-3xl shadow-2xl p-6 sm:p-10 border border-white/50 animate-fade-in">
              <div className="text-center mb-8">
                <div className="w-20 h-20 bg-linear-to-br from-purple-500 to-indigo-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-xl shadow-purple-200 animate-pop-in">
                  <Download className="w-10 h-10 text-white" />
                </div>
                <div className="sm:hidden mb-6 flex justify-center">
                  <UserIdentityDisplay />
                </div>
                <h2 className="text-3xl font-black mb-2 text-purple-900 tracking-tight">
                  Receive Files
                </h2>
                <p className="text-purple-600/70 text-base">
                  Enter the 6-digit code or scan QR
                </p>
              </div>

              <div className="mb-8">
                <input
                  type="text"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  className="w-full text-5xl font-mono font-black text-center text-purple-600 tracking-[0.2em] p-6 border-2 border-purple-100 rounded-2xl focus:border-purple-400 bg-purple-50/30 shadow-inner transition-all outline-none placeholder:text-purple-200"
                  autoFocus
                />
              </div>

              <ScanQrSection
                code={code}
                setCode={setCode}
                onConnect={handleJoinSession}
              />

              <button
                onClick={() => handleJoinSession()}
                disabled={code.length !== 6}
                className="w-full bg-purple-600 text-white py-4 px-6 rounded-2xl hover:bg-purple-700 disabled:bg-purple-100 disabled:text-purple-300 font-bold transition-all shadow-xl shadow-purple-100 mb-8 active:scale-[0.98] transform"
              >
                <Download className="w-5 h-5 mr-2 inline-block" />
                Connect & Start Receiving
              </button>

              <div className="relative mb-4">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-purple-100"></div>
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-white px-4 text-purple-400 font-bold tracking-widest">Or wait for invite</span>
                </div>
              </div>

              {/* Nearby Devices Scanner */}
              <NearbyDevices
                signaling={signalingClient}
                deviceName={name || "Receiver"}
                role="receiver"
                onPair={(device) => {
                  // If we click on a sender, we should probably do something...
                  // But in this app, senders invite receivers.
                  // Maybe we can notify the sender that we are ready?
                  // For now, it just shows that we are visible.
                  console.log("Device selected:", device);
                }}
              />
            </div>
          )}

          {step === "connecting" && (
            <div className="bg-white rounded-2xl shadow-lg p-8 text-center border border-gray-100">
              <div className="w-20 h-20 bg-purple-50 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse shadow-sm">
                <Download className="w-10 h-10 text-purple-500" />
              </div>
              <h2 className="text-3xl text-purple-500 font-bold mb-2">
                Connecting...
              </h2>
              <p className="text-slate-800">Establishing secure connection</p>
            </div>
          )}

          {step === "receiving" && metadataList.length > 0 && (
            <div className="bg-white rounded-2xl shadow-lg p-4 sm:p-8 border border-gray-100">
              <div className="text-center mb-6">
                <div className="w-16 h-16 bg-purple-50 rounded-full flex items-center justify-center mx-auto mb-3 animate-pulse">
                  <Download className="w-8 h-8 text-purple-500" />
                </div>
                <h2 className="text-2xl sm:text-3xl text-purple-500 font-bold mb-2">
                  Receiving Files
                </h2>
                <p className="text-sm text-gray-600">
                  {receivedFiles.filter(Boolean).length} of{" "}
                  {batchMetadata.length || metadataList.length} complete
                </p>
              </div>

              <ul className="space-y-3">
                {metadataList.map((meta, idx) => {
                  if (!meta) return null;

                  const isComplete = receivedFiles[idx] !== null;
                  const isActive = !isComplete && progressList[idx] > 0;
                  const isPending = !isComplete && progressList[idx] === 0;

                  return (
                    <li
                      key={meta.name + idx}
                      className={`rounded-lg p-3 sm:p-4 border transition-all ${isComplete
                        ? "bg-green-50/60 border-green-200"
                        : isActive
                          ? "bg-purple-50/60 border-purple-200 ring-2 ring-purple-300"
                          : "bg-gray-50/60 border-gray-200"
                        }`}
                    >
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          {isComplete && (
                            <Check className="w-5 h-5 text-green-600 shrink-0" />
                          )}
                          {isActive && (
                            <div className="w-5 h-5 shrink-0">
                              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-purple-500"></div>
                            </div>
                          )}
                          <span
                            className={`font-semibold break-all ${isComplete
                              ? "text-green-700"
                              : isActive
                                ? "text-purple-600"
                                : "text-gray-500"
                              }`}
                          >
                            {meta.name}
                          </span>
                        </div>
                        <span className="text-xs sm:text-sm text-gray-600 ml-2 shrink-0">
                          {formatBytes(meta.size)}
                        </span>
                      </div>

                      {!isComplete && (
                        <>
                          <div className="w-full h-2.5 sm:h-3 bg-gray-200 rounded-full overflow-hidden mb-1">
                            <div
                              className={`h-full transition-all duration-300 ${isActive ? "bg-purple-500" : "bg-gray-300"
                                }`}
                              style={{ width: `${progressList[idx] || 0}%` }}
                            />
                          </div>

                          <div className="flex justify-between items-center text-xs text-gray-600 mt-1">
                            <span className="font-medium">
                              {isActive
                                ? `${Math.round(progressList[idx] || 0)}%`
                                : isPending
                                  ? "Waiting..."
                                  : "0%"}
                            </span>

                            {isActive && (
                              <div className="flex items-center gap-2 sm:gap-3">
                                <span className="hidden sm:inline">
                                  {formatSpeed(speedList[idx] || 0)}
                                </span>
                                {timeRemainingList[idx] > 0 && (
                                  <span>
                                    {formatTime(timeRemainingList[idx])} left
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </>
                      )}

                      {isComplete && (
                        <div className="flex items-center justify-between mt-2">
                          <div className="text-xs text-green-600 font-medium">
                            ✓ Complete
                          </div>
                          <button
                            onClick={() => handleDownload(idx)}
                            className="bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded text-xs font-semibold transition-colors flex items-center gap-1"
                            aria-label={`Download ${meta.name}`}
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Download</span>
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* Overall Progress */}
              <div className="mt-6 pt-4 border-t border-gray-200">
                <div className="flex justify-between text-sm text-gray-600 mb-2">
                  <span className="font-medium">Overall Progress</span>
                  <span>
                    {receivedFiles.filter(Boolean).length} /{" "}
                    {batchMetadata.length || metadataList.length} files
                  </span>
                </div>
                <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-linear-to-r from-purple-500 to-blue-500 transition-all duration-500"
                    style={{
                      width: `${(receivedFiles.filter(Boolean).length /
                        (batchMetadata.length || metadataList.length || 1)) *
                        100
                        }%`,
                    }}
                  />
                </div>
              </div>

              {/* Download completed files button */}
              {receivedFiles.filter(Boolean).length > 0 && (
                <div className="mt-4">
                  <button
                    onClick={handleDownloadCompleted}
                    className="w-full bg-purple-500 text-white py-3 rounded-lg hover:bg-purple-600 font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-purple-400 flex items-center justify-center gap-2"
                  >
                    <Download className="w-5 h-5" />
                    Download {receivedFiles.filter(Boolean).length} Completed File
                    {receivedFiles.filter(Boolean).length !== 1 ? "s" : ""}
                  </button>
                  <p className="text-xs text-center text-gray-500 mt-2">
                    You can download completed files while others are still transferring
                  </p>
                </div>
              )}
            </div>
          )}

          {step === "complete" && (
            <div className="bg-white rounded-2xl shadow-lg p-4 sm:p-8 border border-gray-100">
              <div className="text-center mb-6">
                <div className="w-20 h-20 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm animate-bounce-once">
                  <Check className="w-10 h-10 text-green-600" />
                </div>
                <h2 className="text-2xl sm:text-3xl text-purple-500 font-bold mb-2">
                  Transfer Complete!
                </h2>
                <p className="text-gray-600">
                  {receivedFiles.filter(Boolean).length} of{" "}
                  {batchMetadata.length || metadataList.length}{" "}
                  {receivedFiles.filter(Boolean).length === 1
                    ? "file"
                    : "files"}{" "}
                  ready to download
                </p>
              </div>

              <div className="bg-green-50 rounded-lg p-3 sm:p-4 mb-6 border border-green-100">
                <div className="mb-3 pb-3 border-b border-green-200">
                  <p className="text-sm font-semibold text-green-800">
                    Received Files:
                  </p>
                </div>
                <ul className="space-y-2 max-h-96 overflow-y-auto">
                  {(batchMetadata.length > 0
                    ? batchMetadata
                    : metadataList
                  ).map((meta, idx) => {
                    if (!meta) return null;
                    const file = receivedFiles[idx];
                    const isReceived = file !== null;

                    return (
                      <li
                        key={idx}
                        className={`flex justify-between items-center gap-2 p-2 rounded transition-colors ${isReceived ? "hover:bg-green-100/50" : "bg-yellow-50"
                          }`}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          {isReceived ? (
                            <Check className="w-4 h-4 text-green-600 shrink-0" />
                          ) : (
                            <div className="w-4 h-4 shrink-0">
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-yellow-500"></div>
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <span
                              className={`font-semibold block truncate ${isReceived ? "text-gray-900" : "text-yellow-700"
                                }`}
                            >
                              {meta.name}
                            </span>
                            <span className="text-xs text-gray-600">
                              {formatBytes(meta.size)}
                            </span>
                          </div>
                        </div>
                        {isReceived ? (
                          <button
                            onClick={() => handleDownload(idx)}
                            className="bg-purple-500 text-white px-3 py-2 rounded hover:bg-purple-600 flex items-center gap-1 transition-colors focus:outline-none focus:ring-2 focus:ring-purple-400 shrink-0"
                            aria-label={`Download ${meta.name}`}
                          >
                            <Download className="w-4 h-4" />
                            <span className="hidden sm:inline text-sm">
                              Download
                            </span>
                          </button>
                        ) : (
                          <span className="text-xs text-yellow-600 shrink-0 px-2">
                            {progressList[idx] > 0
                              ? `${Math.round(progressList[idx])}%`
                              : "Pending"}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>

              {/* Overall progress bar if not all files received */}
              {receivedFiles.filter(Boolean).length <
                (batchMetadata.length || metadataList.length) && (
                  <div className="mb-6 p-4 bg-purple-50 border border-purple-100 rounded-xl">
                    <div className="flex justify-between text-sm text-purple-800 mb-2">
                      <span className="font-bold">Transfer in progress...</span>
                      <span className="font-mono">
                        {receivedFiles.filter(Boolean).length} /{" "}
                        {batchMetadata.length || metadataList.length}
                      </span>
                    </div>
                    <div className="w-full h-3 bg-purple-100 rounded-full overflow-hidden shadow-inner">
                      <div
                        className="h-full bg-purple-600 transition-all duration-500 rounded-full shadow-lg"
                        style={{
                          width: `${(receivedFiles.filter(Boolean).length /
                            (batchMetadata.length || metadataList.length)) *
                            100
                            }%`,
                        }}
                      />
                    </div>
                  </div>
                )}

              <div className="space-y-4">
                {receivedFiles.filter(Boolean).length > 1 && (
                  <button
                    onClick={handleDownloadCompleted}
                    disabled={
                      receivedFiles.filter(Boolean).length <
                      (batchMetadata.length || metadataList.length)
                    }
                    className="w-full bg-purple-600 text-white py-4 rounded-xl hover:bg-purple-700 disabled:bg-purple-100 disabled:text-purple-300 disabled:cursor-not-allowed font-bold transition-all shadow-lg flex items-center justify-center gap-2 active:scale-[0.98] transform"
                  >
                    <Download className="w-5 h-5" />
                    {receivedFiles.filter(Boolean).length <
                      (batchMetadata.length || metadataList.length)
                      ? "Waiting for all files..."
                      : "Download All as ZIP"}
                  </button>
                )}
                <button
                  onClick={reset}
                  className="w-full bg-white border-2 border-purple-100 py-4 rounded-xl hover:bg-purple-50 hover:border-purple-200 font-bold text-purple-700 transition-all active:scale-[0.98] transform"
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

function ScanQrSection({
  code,
  setCode,
  onConnect,
}: {
  code: string;
  setCode: (c: string) => void;
  onConnect: (scannedCode: string) => void;
}) {
  const [showScanner, setShowScanner] = useState(false);

  const handleResult = useCallback(
    (text: string) => {
      const match = text.match(/code=([A-Z0-9]{6})/i);
      const found = match ? match[1] : text.match(/[A-Z0-9]{6}/i)?.[0];

      if (found) {
        const scanned = found.toUpperCase();
        setCode(scanned);
        setShowScanner(false);
        if (scanned.length === 6) {
          onConnect(scanned);
        }
      }
    },
    [setCode, onConnect]
  );

  return (
    <div className="w-full mb-4">
      <button
        type="button"
        className="w-full px-4 py-3 bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200 font-semibold mb-4"
        onClick={() => setShowScanner((v) => !v)}
      >
        {showScanner ? "Close Scanner" : "Scan QR Code"}
      </button>

      {showScanner && (
        <>
          <QRScannerModal onResult={handleResult} onClose={() => setShowScanner(false)} />
          <p className="text-xs text-gray-500 mt-2 text-center">
            Point camera at QR code
          </p>
        </>
      )}
    </div>
  );
}
