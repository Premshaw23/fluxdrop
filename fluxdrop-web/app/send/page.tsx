// fluxdrop-web/app/send/page.tsx
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";

const QRCode = dynamic(
  () => import("qrcode.react").then((mod) => mod.QRCodeCanvas),
  { ssr: false }
);

import { useRouter } from "next/navigation";
import { ArrowLeft, Upload, Copy, Check, Wifi } from "lucide-react";
import Link from "next/link";
import { SignalingClient } from "@/lib/signaling/SignalingClient";
import { RTCConnection } from "@/lib/webrtc/RTCConnection";
import {
  FileTransferSender,
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

type Step = "select" | "waiting" | "connected" | "transferring" | "complete";

export default function SendPage() {
  const router = useRouter();

  // State management
  const [step, setStep] = useState<Step>("select");
  const stepRef = useRef<Step>("select");
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  const [files, setFiles] = useState<File[]>([]);
  const [sessionCode, setSessionCode] = useState("");
  const [progressList, setProgressList] = useState<number[]>([]);
  const [speedList, setSpeedList] = useState<number[]>([]);
  const [timeRemainingList, setTimeRemainingList] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [errorLog, setErrorLog] = useState<string[]>([]);

  // Options
  const [sendAsZip, setSendAsZip] = useState(false);
  const [readyToSend, setReadyToSend] = useState(false);

  // Resume state
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [resumeInProgress, setResumeInProgress] = useState(false);

  // Connection quality/type indicator state
  const [connectionType, setConnectionType] = useState<string>("");
  const [connectionQuality, setConnectionQuality] = useState<string>("");
  const [isOffline, setIsOffline] = useState<boolean>(false);

  // Debug info
  const [fileDebugInfo, setFileDebugInfo] = useState<
    Array<{ hash?: string; type?: string; size?: number; hex?: string }>
  >([]);

  // Copy status
  const [copyStatus, setCopyStatus] = useState<"none" | "code" | "link">(
    "none"
  );

  // Drag & drop state
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ECDH state
  const ecdhKeyPairRef = useRef<{
    publicKey: CryptoKey;
    privateKey: CryptoKey;
  } | null>(null);
  const peerPublicKeyRef = useRef<CryptoKey | null>(null);
  const sharedSecretRef = useRef<CryptoKey | null>(null);

  // Connection refs
  const signalingRef = useRef<SignalingClient | null>(null);
  const rtcRef = useRef<RTCConnection | null>(null);
  const transferRef = useRef<FileTransferSender | null>(null);
  const dataChannelReadyRef = useRef(false);
  const filesRef = useRef<File[]>([]);

  // CRITICAL FIX: Track transfer completion state
  const transferCompleteRef = useRef(false);
  const filesSuccessfullySentRef = useRef(false);
  const transferStartedRef = useRef(false);

  // CRITICAL FIX: Track component mounted state
  const isMountedRef = useRef(true);

  // CRITICAL FIX: Prevent duplicate operations
  const isResettingRef = useRef(false);
  const handshakeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize mounted state and offline detection
  useEffect(() => {
    isMountedRef.current = true;
    if (typeof window !== "undefined" && typeof navigator !== "undefined") {
      setIsOffline(!navigator.onLine);
    }
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Listen for online/offline events
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

      // CRITICAL FIX: Only cleanup if transfer not complete
      if (!filesSuccessfullySentRef.current && !transferCompleteRef.current) {
        if (signalingRef.current?.isConnected()) {
          try {
            signalingRef.current.send({ type: "session-cancel" });
          } catch (err) {
            console.warn("[SendPage] Failed to send cancel on unmount:", err);
          }
        }
        transferRef.current?.cancel();
        rtcRef.current?.close();
        signalingRef.current?.disconnect();
      }

      // Clear handshake timeout
      if (handshakeTimeoutRef.current) {
        clearTimeout(handshakeTimeoutRef.current);
      }
    };
  }, []);

  // CRITICAL FIX: Better peer disconnect handler
  const handlePeerDisconnect = useCallback(() => {
    console.warn("[SendPage] Peer disconnected");
    if (!isMountedRef.current) return;

    // CRITICAL: If files already sent successfully, just show info message
    if (
      transferCompleteRef.current ||
      filesSuccessfullySentRef.current ||
      stepRef.current === "complete"
    ) {
      setError("Receiver disconnected. Your files were sent successfully.");
      return;
    }

    // Only reset if transfer was incomplete
    setError(
      "Receiver disconnected during transfer. Please try again or resend files."
    );
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
      await rtcRef.current.initialize("sender");

      if (
        typeof (transferRef.current as any).handleResumeRequest === "function"
      ) {
        const unsent = (transferRef.current as any).sentChunkBitmap
          ? (transferRef.current as any).sentChunkBitmap
              .map((sent: boolean, idx: number) => (sent ? null : idx))
              .filter((v: number | null) => v !== null)
          : [];
        if (unsent.length > 0) {
          await (transferRef.current as any).handleResumeRequest(unsent);
        }
      }

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

  // CRITICAL FIX: Check and start transfer when conditions are met
  const checkAndStartTransfer = useCallback(() => {
    if (
      dataChannelReadyRef.current &&
      sharedSecretRef.current &&
      filesRef.current.length > 0 &&
      !transferStartedRef.current
    ) {
      console.log("[SendPage] All conditions met, starting transfer");
      transferStartedRef.current = true;
      startTransfer(filesRef.current);
    }
  }, []);

  const handleFiles = (selectedFiles: File[]) => {
    if (selectedFiles.length === 0) return;

    const sortedFiles = [...selectedFiles].sort((a, b) => {
      const aPath = (a as any).webkitRelativePath || a.name;
      const bPath = (b as any).webkitRelativePath || b.name;
      return aPath.localeCompare(bPath);
    });

    if (
      sendAsZip &&
      sortedFiles.length > 0 &&
      (sortedFiles.length > 1 || (sortedFiles[0] as any).webkitRelativePath)
    ) {
      import("jszip").then((JSZipModule) => {
        const JSZip = JSZipModule.default;
        const zip = new JSZip();
        const allFiles = [...filesRef.current, ...sortedFiles];
        allFiles.forEach((f) => {
          const relPath = (f as any).webkitRelativePath || f.name;
          zip.file(relPath, f);
        });
        zip.generateAsync({ type: "blob" }).then((blob) => {
          const zipFile = new File([blob], "fluxdrop-files.zip", {
            type: "application/zip",
          });
          setFiles([zipFile]);
          filesRef.current = [zipFile];
          setProgressList([0]);
          setSpeedList([0]);
          setTimeRemainingList([0]);
          setReadyToSend(true);
        });
      });
      return;
    }

    const updatedFiles = [...filesRef.current, ...sortedFiles];
    const uniqueFiles = updatedFiles.filter(
      (file, index, self) =>
        index ===
        self.findIndex((f) => f.name === file.name && f.size === file.size)
    );
    setFiles(uniqueFiles);
    filesRef.current = uniqueFiles;
    setProgressList(new Array(uniqueFiles.length).fill(0));
    setSpeedList(new Array(uniqueFiles.length).fill(0));
    setTimeRemainingList(new Array(uniqueFiles.length).fill(0));
    setReadyToSend(true);
  };

  const removeFile = (index: number) => {
    const updatedFiles = files.filter((_, idx) => idx !== index);
    setFiles(updatedFiles);
    filesRef.current = updatedFiles;
    setProgressList(new Array(updatedFiles.length).fill(0));
    setSpeedList(new Array(updatedFiles.length).fill(0));
    setTimeRemainingList(new Array(updatedFiles.length).fill(0));
    if (updatedFiles.length === 0) {
      setReadyToSend(false);
    }
  };

  const removeAllFiles = () => {
    setFiles([]);
    filesRef.current = [];
    setProgressList([]);
    setSpeedList([]);
    setTimeRemainingList([]);
    setReadyToSend(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files
      ? Array.from(event.target.files)
      : [];
    handleFiles(selectedFiles);
  };

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
            const files = await Promise.all(
              entries.map((entry) =>
                traverseFileTree(entry, path + item.name + "/")
              )
            );
            resolve(files.flat());
          });
        } else {
          resolve([]);
        }
      });
    };

    if (event.dataTransfer.items) {
      const items = Array.from(event.dataTransfer.items);
      Promise.all(
        items.map(async (item) => {
          const entry = (item as any).webkitGetAsEntry?.();
          if (entry) {
            return await traverseFileTree(entry);
          } else if (item.kind === "file") {
            const file = item.getAsFile();
            return file ? [file] : [];
          }
          return [];
        })
      ).then((results) => {
        droppedFiles = results.flat();
        handleFiles(droppedFiles);
      });
    } else {
      droppedFiles = Array.from(event.dataTransfer.files);
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

  const handleSend = () => {
    if (!filesRef.current.length) {
      setError("Please select at least one file or folder to send.");
      setStep("select");
      return;
    }
    setError("");
    setStep("waiting");
    setProgressList(new Array(filesRef.current.length).fill(0));
    setSpeedList(new Array(filesRef.current.length).fill(0));
    setTimeRemainingList(new Array(filesRef.current.length).fill(0));
    setErrorLog([]);
    dataChannelReadyRef.current = false;
    transferStartedRef.current = false;
    transferCompleteRef.current = false;
    filesSuccessfullySentRef.current = false;
    setReadyToSend(false);
    initializeConnection();
  };

  const initializeConnection = async () => {
    try {
      const signalingUrl =
        process.env.NEXT_PUBLIC_SIGNALING_URL || "ws://localhost:3001";
      const signaling = new SignalingClient(signalingUrl);
      signalingRef.current = signaling;

      await signaling.connect();

      const rtc = new RTCConnection({
        onStateChange: (state) => {
          if (!isMountedRef.current) return;

          if (state === "connected") {
            setStep("connected");
          } else if (state === "failed") {
            // CRITICAL FIX: Don't show error if transfer complete
            if (
              !transferCompleteRef.current &&
              !filesSuccessfullySentRef.current
            ) {
              setError("Connection failed. Please try again.");
            }
          }
        },
        onDataChannelOpen: () => {
          console.log("[SendPage] Data channel opened");
          dataChannelReadyRef.current = true;
          checkAndStartTransfer();
        },
        onError: (err) => {
          if (!isMountedRef.current) return;

          // CRITICAL FIX: Don't show errors if transfer complete
          if (transferCompleteRef.current || filesSuccessfullySentRef.current) {
            console.log(
              "[SendPage] Ignoring error after transfer complete:",
              err
            );
            return;
          }

          setError(err.message);
          if (
            err.message &&
            (err.message.includes("data channel") ||
              err.message.includes("Connection failed"))
          ) {
            setResumeAvailable(true);
            setResumeInProgress(false);
          }
        },
      });
      rtcRef.current = rtc;

      await rtc.initialize("sender");

      signaling.on("session-created", (message) => {
        if (isMountedRef.current) {
          setSessionCode(message.code);
        }
      });

      signaling.on("peer-joined", async () => {
        if (!isMountedRef.current) return;

        console.log("[SendPage] Peer joined");
        setStep("connected");

        // CRITICAL FIX: Clear any existing handshake timeout
        if (handshakeTimeoutRef.current) {
          clearTimeout(handshakeTimeoutRef.current);
        }

        // CRITICAL FIX: Set handshake timeout
        handshakeTimeoutRef.current = setTimeout(() => {
          if (!sharedSecretRef.current && isMountedRef.current) {
            setError("Handshake timeout. Please try again.");
            reset();
          }
        }, 10000); // 10 second timeout

        const keyPair = await generateECDHKeyPair();
        ecdhKeyPairRef.current = keyPair;
        const exported = await exportPublicKey(keyPair.publicKey);
        const pubKeyB64 = btoa(
          String.fromCharCode(...new Uint8Array(exported))
        );
        signaling.sendPublicKey(pubKeyB64);

        await rtc.createDataChannel();
        const offer = await rtc.createOffer();
        signaling.sendOffer(offer.sdp!);
      });

      signaling.on("public-key", async (message) => {
        if (!isMountedRef.current) return;

        console.log("[SendPage] Received peer public key");
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
          console.log("[SendPage] Shared secret derived");

          // CRITICAL FIX: Clear handshake timeout on success
          if (handshakeTimeoutRef.current) {
            clearTimeout(handshakeTimeoutRef.current);
            handshakeTimeoutRef.current = null;
          }

          checkAndStartTransfer();
        }
      });

      signaling.on("answer", async (message) => {
        await rtc.setRemoteDescription({ type: "answer", sdp: message.sdp });
      });

      signaling.on("ice-candidate", async (message) => {
        await rtc.addIceCandidate(message.candidate);
      });

      signaling.on("error", (message) => {
        if (!isMountedRef.current) return;

        // CRITICAL FIX: Don't reset if transfer complete
        if (transferCompleteRef.current || filesSuccessfullySentRef.current) {
          setError("Connection error, but your files were sent successfully.");
          return;
        }

        setError(message.error);
      });

      // CRITICAL FIX: Better disconnect handlers
      signaling.on("peer-disconnected", handlePeerDisconnect);
      signaling.on("session-cancel", handlePeerDisconnect);
      signaling.on("session-reset", handlePeerDisconnect);

      rtc.onIceCandidate = (candidate) => {
        signaling.sendIceCandidate(candidate);
      };

      signaling.createSession();
    } catch (err) {
      if (!isMountedRef.current) return;

      if (transferCompleteRef.current || filesSuccessfullySentRef.current) {
        setError("Connection error, but your files were sent successfully.");
        return;
      }

      setError(
        err instanceof Error ? err.message : "Failed to initialize connection"
      );
    }
  };

  const startTransfer = async (selectedFiles: File[]) => {
    if (!selectedFiles.length) {
      setError(
        "No files selected. Please select at least one file or folder to send."
      );
      setStep("select");
      return;
    }

    console.log("[SendPage] startTransfer called", {
      selectedFiles,
      rtcRef: rtcRef.current,
    });

    if (!rtcRef.current) {
      setError("Connection not established. Please try again.");
      setStep("select");
      return;
    }

    if (!sharedSecretRef.current) {
      setError(
        "Encryption handshake not complete. Please wait for the connection to establish before sending files."
      );
      return;
    }

    // Calculate debug info for each file
    Promise.all(
      selectedFiles.map(async (file) => {
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
        return {
          hash: hashB64,
          type: file.type,
          size: file.size,
          hex,
        };
      })
    ).then((info) => {
      if (isMountedRef.current) setFileDebugInfo(info);
    });

    if (isMountedRef.current) setStep("transferring");

    const transfer = new FileTransferSender(
      (data) => {
        console.log("[SendPage] rtc.send called, bytes:", data.byteLength);
        return rtcRef.current!.send(data);
      },
      () => rtcRef.current!.getBufferedAmount(),
      () => rtcRef.current!.getDataChannelState()
    );

    transfer.setEncryptionKey(sharedSecretRef.current);
    transferRef.current = transfer;

    transfer.onProgress = (prog) => {
      if (!isMountedRef.current) return;

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
      console.log("[SendPage] transfer.onComplete called");

      if (!isMountedRef.current) return;

      // CRITICAL FIX: Mark transfer as complete
      transferCompleteRef.current = true;
      filesSuccessfullySentRef.current = true;

      setProgressList((prev) => prev.map(() => 100));
      setStep("complete");

      // Clear keys after transfer
      ecdhKeyPairRef.current = null;
      peerPublicKeyRef.current = null;
      sharedSecretRef.current = null;
    };

    transfer.onError = (err) => {
      console.log("[SendPage] transfer.onError called", err);

      if (!isMountedRef.current) return;

      // CRITICAL FIX: Don't show errors if transfer complete
      if (transferCompleteRef.current || filesSuccessfullySentRef.current) {
        console.log("[SendPage] Ignoring error after transfer complete:", err);
        return;
      }

      setError(err.message);
      setErrorLog((prev) => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] ${err.message}`,
      ]);

      // Clear keys on error
      ecdhKeyPairRef.current = null;
      peerPublicKeyRef.current = null;
      sharedSecretRef.current = null;
    };

    await transfer.startBatchTransfer(selectedFiles);
  };

  const copyCode = () => {
    navigator.clipboard.writeText(sessionCode);
    setCopyStatus("code");
    setTimeout(() => setCopyStatus("none"), 2000);
  };

  const copyLink = () => {
    const url = `${
      typeof window !== "undefined" ? window.location.origin : ""
    }/receive?code=${sessionCode}`;
    navigator.clipboard.writeText(url);
    setCopyStatus("link");
    setTimeout(() => setCopyStatus("none"), 2000);
  };

  const reset = () => {
    // CRITICAL FIX: Prevent duplicate resets
    if (isResettingRef.current) return;
    isResettingRef.current = true;

    // Clear handshake timeout
    if (handshakeTimeoutRef.current) {
      clearTimeout(handshakeTimeoutRef.current);
      handshakeTimeoutRef.current = null;
    }

    // Inform peer only if still connected
    if (signalingRef.current?.isConnected()) {
      try {
        signalingRef.current.send({ type: "session-reset" });
      } catch (err) {
        console.warn("[SendPage] Failed to send reset signal:", err);
      }
    }

    // Only close connections if transfer complete or not started
    if (transferCompleteRef.current || !transferStartedRef.current) {
      transferRef.current?.cancel();
      rtcRef.current?.close();
      signalingRef.current?.disconnect();
    }

    // Reset all refs
    dataChannelReadyRef.current = false;
    filesRef.current = [];
    transferRef.current = null;
    rtcRef.current = null;
    signalingRef.current = null;
    transferStartedRef.current = false;
    transferCompleteRef.current = false;
    filesSuccessfullySentRef.current = false;

    // Reset state
    setStep("select");
    setFiles([]);
    setSessionCode("");
    setProgressList([]);
    setSpeedList([]);
    setTimeRemainingList([]);
    setError("");
    setErrorLog([]);
    if (fileInputRef.current) fileInputRef.current.value = "";

    setTimeout(() => {
      isResettingRef.current = false;
    }, 100);
  };

  const handleRetry = () => {
    // CRITICAL FIX: Preserve file selection defensively
    if (filesRef.current.length === 0 && files.length === 0) {
      setError("No files to retry. Please select files first.");
      setStep("select");
      return;
    }

    if (filesRef.current.length === 0 && files.length > 0) {
      filesRef.current = [...files];
    }

    setError("");
    setStep("waiting");
    setProgressList(new Array(filesRef.current.length).fill(0));
    setSpeedList(new Array(filesRef.current.length).fill(0));
    setTimeRemainingList(new Array(filesRef.current.length).fill(0));
    setErrorLog((prev) => [
      ...prev,
      `[${new Date().toLocaleTimeString()}] Retrying transfer...`,
    ]);
    dataChannelReadyRef.current = false;
    transferStartedRef.current = false;
    transferCompleteRef.current = false;
    filesSuccessfullySentRef.current = false;
    initializeConnection();
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-blue-50 via-white to-purple-50">
      <header className="border-b bg-white/60 backdrop-blur-md shadow-sm sticky top-0 z-20">
        <div className="container mx-auto px-4 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-gray-700 hover:text-gray-900"
          >
            <ArrowLeft className="w-5 h-5" />
            <span>Back</span>
          </Link>
          <div className="flex items-center gap-2">
            {isOffline ? (
              <span className="text-red-600 font-semibold flex items-center gap-1">
                <Wifi className="w-4 h-4" />
                Offline
              </span>
            ) : connectionType ? (
              <span className="text-xs px-2 py-1 rounded bg-gray-100 border border-gray-200 text-gray-700 font-semibold flex items-center gap-1">
                <Wifi className="w-4 h-4" />
                {connectionType}{" "}
                <span
                  className={
                    connectionQuality === "good"
                      ? "text-green-600"
                      : connectionQuality === "fair"
                      ? "text-yellow-600"
                      : connectionQuality === "poor"
                      ? "text-red-600"
                      : ""
                  }
                >
                  {connectionQuality}
                </span>
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-2 py-8 sm:px-4 sm:py-16">
        <div className="max-w-2xl mx-auto">
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 shadow animate-shake">
              <div className="font-bold text-lg mb-1">{error}</div>
              {filesRef.current.length > 0 &&
                files.length > 0 &&
                !transferCompleteRef.current && (
                  <button
                    onClick={handleRetry}
                    className="mt-3 w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors font-semibold shadow"
                  >
                    Retry
                  </button>
                )}
              {errorLog.length > 0 && (
                <div className="mt-2 text-xs text-gray-500">
                  <div className="font-bold mb-1">Error Log:</div>
                  <ul className="list-disc pl-4">
                    {errorLog.map((msg, idx) => (
                      <li key={idx}>{msg}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {resumeAvailable && (
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 flex flex-col items-center">
              <div className="font-semibold mb-2">Transfer interrupted</div>
              <div className="mb-2">
                You can try to resume the transfer and resend missing chunks.
              </div>
              <button
                onClick={handleResume}
                disabled={resumeInProgress}
                className="bg-yellow-600 text-white px-4 py-2 rounded hover:bg-yellow-700 font-semibold disabled:opacity-50"
              >
                {resumeInProgress ? "Resuming..." : "Resume Transfer"}
              </button>
            </div>
          )}

          {step === "select" && (
            <div className="bg-white rounded-2xl shadow-2xl p-4 sm:p-8 animate-fade-in">
              <div className="text-center mb-8">
                <div className="w-20 h-20 bg-linear-to-br from-blue-200 via-blue-100 to-purple-200 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg animate-pop-in">
                  <Upload className="w-12 h-12 text-blue-600" />
                </div>
                <h2 className="text-3xl font-extrabold text-gray-900 mb-2 tracking-tight">
                  Send Files
                </h2>
                <p className="text-gray-600 text-base">
                  Choose files or folders to share instantly. Fast, secure, and
                  private.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <input
                    id="sendAsZip"
                    type="checkbox"
                    checked={sendAsZip}
                    onChange={(e) => setSendAsZip(e.target.checked)}
                    className="mr-2 accent-blue-600 focus:ring-blue-500"
                  />
                  <label
                    htmlFor="sendAsZip"
                    className="text-sm text-gray-700 select-none cursor-pointer"
                  >
                    <span className="font-semibold">Send as ZIP</span>{" "}
                    <span className="text-gray-500">
                      (preserves folder structure)
                    </span>
                  </label>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-4 mb-4">
                <label className="block w-full">
                  <input
                    type="file"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                    ref={fileInputRef}
                  />
                  <button
                    type="button"
                    className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg hover:bg-blue-700 transition-colors font-semibold mb-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 shadow"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label={
                      files.length > 0 ? "Add more files" : "Select files"
                    }
                  >
                    <Upload className="w-5 h-5 mr-2 inline-block" />
                    {files.length > 0 ? "Add More Files" : "Select Files"}
                  </button>
                </label>
                <label className="block w-full">
                  <input
                    type="file"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                    ref={(el) => {
                      if (el) {
                        el.setAttribute("webkitdirectory", "");
                        el.setAttribute("directory", "");
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="w-full bg-purple-600 text-white py-3 px-6 rounded-lg hover:bg-purple-700 transition-colors font-semibold mb-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 shadow"
                    onClick={(e) => {
                      const input =
                        e.currentTarget.parentElement?.querySelector(
                          'input[type="file"]'
                        ) as HTMLInputElement;
                      input?.click();
                    }}
                    aria-label={
                      files.length > 0 ? "Add folder" : "Select folder"
                    }
                  >
                    <Upload className="w-5 h-5 mr-2 inline-block" />
                    {files.length > 0 ? "Add Folder" : "Select Folder"}
                  </button>
                </label>
              </div>

              <div
                className={`border-2 border-dashed rounded-xl p-6 sm:p-12 text-center cursor-pointer transition-colors select-none ${
                  isDragActive
                    ? "border-blue-500 bg-blue-100 shadow-lg"
                    : "border-gray-300 hover:border-blue-500 hover:bg-blue-50"
                } focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 animate-fade-in`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                role="button"
                tabIndex={0}
                aria-label="Select files to send"
                style={{ touchAction: "manipulation" }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    fileInputRef.current?.click();
                  }
                }}
              >
                <Upload className="w-12 h-12 text-blue-400 mx-auto mb-4 animate-bounce" />
                <p className="text-lg text-gray-700 mb-2 font-semibold">
                  {files.length > 0
                    ? "Add more files or folders"
                    : "Tap or drag files or folders here"}
                </p>
                <p className="text-sm text-gray-500">
                  Any file up to 2GB each. Folder structure will be preserved.
                </p>
                {isDragActive && (
                  <div className="mt-2 text-blue-600 font-semibold animate-pulse">
                    Drop files or folders to select
                  </div>
                )}
              </div>

              {files.length > 0 && (
                <>
                  <div className="mt-6 flex justify-between items-center mb-2">
                    <h3 className="text-lg font-bold text-gray-900">
                      Selected Files{" "}
                      <span className="text-blue-600">({files.length})</span>
                    </h3>
                    <button
                      onClick={removeAllFiles}
                      className="text-sm text-red-600 hover:text-red-700 font-semibold px-3 py-1 rounded border border-red-300 hover:bg-red-50 transition shadow"
                    >
                      Remove All
                    </button>
                  </div>
                  <div className="mt-4 sm:mt-6 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                    {files.map((f, idx) => {
                      const isImage = f.type.startsWith("image/");
                      const isVideo = f.type.startsWith("video/");
                      const isAudio = f.type.startsWith("audio/");
                      return (
                        <div
                          key={f.name + f.size + idx}
                          className="bg-linear-to-br from-gray-50 via-white to-blue-50 rounded-lg p-4 flex flex-col items-center shadow relative border border-gray-200 hover:shadow-lg transition-all"
                        >
                          <button
                            onClick={() => removeFile(idx)}
                            className="absolute top-2 right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600 transition text-xs font-bold shadow"
                            aria-label="Remove file"
                          >
                            ×
                          </button>
                          {isImage ? (
                            <img
                              src={URL.createObjectURL(f)}
                              alt={f.name}
                              className="w-20 h-20 object-cover rounded mb-2 border shadow"
                              loading="lazy"
                              onLoad={(e) =>
                                URL.revokeObjectURL(
                                  (e.target as HTMLImageElement).src
                                )
                              }
                            />
                          ) : isVideo ? (
                            <div className="w-20 h-20 flex items-center justify-center bg-gray-200 rounded mb-2">
                              <span className="text-xs text-gray-500">
                                🎬 Video
                              </span>
                            </div>
                          ) : isAudio ? (
                            <div className="w-20 h-20 flex items-center justify-center bg-gray-200 rounded mb-2">
                              <span className="text-xs text-gray-500">
                                🎵 Audio
                              </span>
                            </div>
                          ) : (
                            <div className="w-20 h-20 flex items-center justify-center bg-gray-200 rounded mb-2">
                              <span className="text-xs text-gray-500">
                                📄 {f.type ? f.type.split("/")[1] : "File"}
                              </span>
                            </div>
                          )}
                          <span className="font-medium text-gray-900 break-all text-center text-sm mb-1 line-clamp-2">
                            {f.name}
                          </span>
                          <span className="text-xs text-gray-600">
                            {formatBytes(f.size)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {readyToSend && (
                    <button
                      className="mt-8 w-full px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-bold text-lg shadow-lg animate-pop-in"
                      onClick={handleSend}
                    >
                      <Upload className="w-5 h-5 mr-2 inline-block" />
                      Send {files.length}{" "}
                      {files.length === 1 ? "File" : "Files"}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {step === "waiting" && (
            <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-8 animate-fade-in">
              <div className="text-center mb-8">
                <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-bounce-slow">
                  <Wifi className="w-10 h-10 text-blue-600 animate-pulse" />
                </div>
                <h2 className="text-3xl font-bold text-gray-900 mb-2 animate-fade-in">
                  Share This Code
                </h2>
                <p className="text-gray-600 animate-fade-in">
                  Waiting for receiver to join...
                </p>
              </div>

              {files.length > 0 && (
                <div className="bg-gray-50 rounded-lg p-4 mb-6 animate-fade-in">
                  <p className="text-sm text-gray-500 mb-1">Selected files:</p>
                  <ul className="space-y-1">
                    {files.map((f, idx) => (
                      <li
                        key={f.name + f.size}
                        className="flex justify-between items-center"
                      >
                        <span className="font-semibold text-gray-900">
                          {f.name}
                        </span>
                        <span className="text-sm text-gray-600">
                          {formatBytes(f.size)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="bg-blue-50 rounded-xl p-4 sm:p-6 mb-6 animate-fade-in flex flex-col items-center w-full max-w-xs sm:max-w-md mx-auto">
                <p className="text-sm text-gray-600 mb-2 text-center">
                  Transfer Code
                </p>
                <div className="text-5xl sm:text-6xl font-bold text-blue-600 text-center tracking-wider mb-4 animate-fade-in select-all">
                  {sessionCode || "------"}
                </div>
                {sessionCode && (
                  <>
                    <div className="mb-4 flex flex-col items-center w-full">
                      <div className="w-full flex justify-center">
                        <QRCode
                          value={`${
                            typeof window !== "undefined"
                              ? window.location.origin
                              : ""
                          }/receive?code=${sessionCode}`}
                          size={
                            typeof window !== "undefined" &&
                            window.innerWidth < 400
                              ? 180
                              : 220
                          }
                          style={{
                            width: "100%",
                            height: "auto",
                            maxWidth: 220,
                            minWidth: 120,
                          }}
                        />
                      </div>
                      <div className="text-xs text-gray-500 mt-2 break-all text-center w-full max-w-full select-all">
                        {`${
                          typeof window !== "undefined"
                            ? window.location.origin
                            : ""
                        }/receive?code=${sessionCode}`}
                      </div>
                    </div>
                    <div className="flex flex-col sm:flex-row m-4 w-full">
                      <button
                        onClick={copyCode}
                        className="flex-1 bg-white border border-blue-200 text-blue-600 py-3 px-4 rounded-lg hover:bg-blue-50 transition-colors flex items-center justify-center gap-2 animate-fade-in text-base sm:text-lg touch-manipulation"
                        style={{ minHeight: 48 }}
                        aria-label="Copy Code"
                      >
                        {copyStatus === "code" ? (
                          <>
                            <Check className="w-5 h-5" />
                            Code Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="w-5 h-5" />
                            Copy Code
                          </>
                        )}
                      </button>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2 w-full">
                      <button
                        onClick={copyLink}
                        className="flex-1 bg-white border border-blue-200 text-blue-600 py-3 px-4 rounded-lg hover:bg-blue-50 transition-colors flex items-center justify-center gap-2 animate-fade-in text-base sm:text-lg touch-manipulation"
                        style={{ minHeight: 48 }}
                        aria-label="Copy Link"
                      >
                        {copyStatus === "link" ? (
                          <>
                            <Check className="w-5 h-5" />
                            Link Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="w-5 h-5" />
                            Copy Link
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => {
                          const url = `${
                            typeof window !== "undefined"
                              ? window.location.origin
                              : ""
                          }/receive?code=${sessionCode}`;
                          if (navigator.share) {
                            navigator.share({
                              title: "FluxDrop Session",
                              text: "Join my FluxDrop session:",
                              url,
                            });
                          } else {
                            copyLink();
                          }
                        }}
                        className="flex-1 bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 animate-fade-in text-base sm:text-lg touch-manipulation"
                        style={{ minHeight: 48 }}
                        aria-label="Share Link"
                      >
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M15 8a3 3 0 00-6 0v4a3 3 0 006 0V8z"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M19 8v4a7 7 0 01-14 0V8"
                          />
                        </svg>
                        Share Link
                      </button>
                    </div>
                  </>
                )}
              </div>

              <p className="text-center text-sm text-gray-500 animate-fade-in">
                Code expires in 5 minutes
              </p>
            </div>
          )}

          {step === "connected" && (
            <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-8 text-center">
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Check className="w-10 h-10 text-green-600" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-2">
                Connected!
              </h2>
              <p className="text-gray-600">Starting transfer...</p>
            </div>
          )}

          {step === "transferring" && (
            <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-8">
              <h2 className="text-3xl font-bold text-gray-900 mb-6 text-center">
                Sending Files
              </h2>

              {files.length > 0 && (
                <div className="mb-4 sm:mb-6">
                  <ul className="space-y-2">
                    {files.map((f, idx) => (
                      <li
                        key={f.name + f.size}
                        className="bg-gray-50 rounded-lg px-2 py-2 sm:px-4"
                      >
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-1">
                          <span className="font-semibold text-gray-900 break-all">
                            {f.name}
                          </span>
                          <span className="text-sm text-gray-600 mt-1 sm:mt-0">
                            {formatBytes(f.size)}
                          </span>
                        </div>
                        <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-600 transition-all duration-300"
                            style={{ width: `${progressList[idx] || 0}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-xs text-gray-500 mt-1">
                          <span>{Math.round(progressList[idx] || 0)}%</span>
                          <span>{formatSpeed(speedList[idx] || 0)}</span>
                          <span>
                            {timeRemainingList[idx] > 0
                              ? `${formatTime(timeRemainingList[idx])} left`
                              : ""}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {step === "complete" && (
            <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-8 text-center">
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Check className="w-10 h-10 text-green-600" />
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-2">
                Transfer Complete!
              </h2>
              <p className="text-gray-600 mb-6">
                Your files were sent successfully
              </p>

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
