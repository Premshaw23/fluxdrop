// fluxdrop-web/app/send/page.tsx
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";

const QRCode = dynamic(
  () => import("qrcode.react").then((mod) => mod.QRCodeCanvas),
  { ssr: false }
);

import { useRouter } from "next/navigation";
import { ArrowLeft, Upload, Copy, Check, Wifi, User, Link as LinkIcon, Smartphone, Link2 } from "lucide-react";
import Link from "next/link";
import NearbyDevices from "@/components/NearbyDevices";
import { SignalingClient } from "@/lib/signaling/SignalingClient";
import { RTCConnection } from "@/lib/webrtc/RTCConnection";
import {
  FileTransferSender,
  formatBytes,
  formatSpeed,
  formatTime,
} from "@/lib/transfer/FileTransfer";
import UserIdentityDisplay from "@/components/UserIdentityDisplay";
import { useUserStore } from "@/lib/store";
import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedSecret,
} from "@/lib/crypto/crypto";

type Step = "select" | "waiting" | "connecting" | "connected" | "transferring" | "complete";
type PairingMethod = "qr" | "nearby" | null;

export default function SendPage() {
  const router = useRouter();

  // User Identity
  const { name, ensureName } = useUserStore();

  useEffect(() => {
    ensureName();
  }, [ensureName]);

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
  const [pairingMethod, setPairingMethod] = useState<PairingMethod>(null);
  const [pairedDeviceName, setPairedDeviceName] = useState<string>("");

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

  // Discovery & Invite State
  const [discoveryClient, setDiscoveryClient] = useState<SignalingClient | null>(
    null
  );
  const pendingInviteRef = useRef<any>(null);

  // Initialize discovery
  useEffect(() => {
    const signalingUrl =
      process.env.NEXT_PUBLIC_SIGNALING_URL || "ws://localhost:3001";
    const client = new SignalingClient(signalingUrl);

    client
      .connect()
      .then(() => {
        if (isMountedRef.current) {
          setDiscoveryClient(client);
          // Reuse this connection for transfer if possible
          if (!signalingRef.current) {
            signalingRef.current = client;
          }
        }
      })
      .catch((err) => console.error("Discovery connect failed:", err));

    return () => {
      // Don't disconnect explicitly here to allow handover to main signalingRef
      // The main cleanup ref handles signalingRef disconnection
      if (client !== signalingRef.current) {
        client.disconnect();
      }
    };
  }, []);

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

  const startTransfer = useCallback(async (selectedFiles: File[]) => {
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

      const fileIdx = prog.fileIndex !== undefined ? prog.fileIndex : transfer.fileIndex;
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

    transfer.onFileComplete = (fileIdx) => {
      console.log(`[SendPage] File ${fileIdx} complete`);
      if (!isMountedRef.current) return;

      setProgressList((prev) => {
        const updated = [...prev];
        updated[fileIdx] = 100;
        return updated;
      });
      setSpeedList((prev) => {
        const updated = [...prev];
        updated[fileIdx] = 0;
        return updated;
      });
      setTimeRemainingList((prev) => {
        const updated = [...prev];
        updated[fileIdx] = 0;
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
  }, []);

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
  }, [startTransfer]);

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
    setPairingMethod("qr");
    setPairedDeviceName("");
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

  const handlePairDevice = useCallback(
    (device: any) => {
      if (files.length === 0 && filesRef.current.length === 0) {
        setError("Please select files first.");
        return;
      }

      // Store pairing info
      setPairingMethod("nearby");
      setPairedDeviceName(device.name || "Unknown Device");
      pendingInviteRef.current = device;

      // Set to connecting state instead of waiting
      setStep("connecting");
      setError("");
      setProgressList(new Array(filesRef.current.length).fill(0));
      setSpeedList(new Array(filesRef.current.length).fill(0));
      setTimeRemainingList(new Array(filesRef.current.length).fill(0));
      setErrorLog([]);
      dataChannelReadyRef.current = false;
      transferStartedRef.current = false;
      transferCompleteRef.current = false;
      filesSuccessfullySentRef.current = false;
      setReadyToSend(false);

      // Initialize connection
      initializeConnection();
    },
    [files]
  );

  const initializeConnection = async () => {
    try {
      const signalingUrl =
        process.env.NEXT_PUBLIC_SIGNALING_URL || "ws://localhost:3001";

      // Reuse existing client if available
      let signaling = signalingRef.current;

      if (!signaling) {
        signaling = new SignalingClient(signalingUrl);
        signalingRef.current = signaling;
      }

      if (!signaling.isConnected()) {
        await signaling.connect();
      }

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
        onMessage: (data) => {
          // ✅ NEW: Handle acknowledgments from receiver
          transferRef.current?.handleMessage(data);
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

          // Handle pending invite
          if (pendingInviteRef.current) {
            console.log("Sending invite to:", pendingInviteRef.current.name);
            signaling.inviteDevice(
              pendingInviteRef.current.id,
              message.code,
              "Sender" // We could use a real name if we had one
            );
            pendingInviteRef.current = null;
          }
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

  const copyCode = () => {
    navigator.clipboard.writeText(sessionCode);
    setCopyStatus("code");
    setTimeout(() => setCopyStatus("none"), 2000);
  };

  const copyLink = () => {
    const url = `${typeof window !== "undefined" ? window.location.origin : ""
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
    setPairingMethod(null);
    setPairedDeviceName("");
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

  // FULL INTEGRATION - Replace your entire return statement with this:
  return (
    <div className="min-h-screen bg-linear-to-br from-white via-blue-50 to-purple-50">
      <style jsx>{`
         @keyframes pulse-ring {
           0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(147, 51, 234, 0.7); }
           70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(147, 51, 234, 0); }
           100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(147, 51, 234, 0); }
         }
         .animate-pulse-ring {
           animation: pulse-ring 2s infinite;
         }
      `}</style>

      {/* Header */}
      <header className="border-b bg-white/60 backdrop-blur-md shadow-sm sticky top-0 z-20">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-purple-900 hover:text-purple-700 font-semibold transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            <span>Back</span>
          </Link>
          <div className="flex items-center gap-2 sm:gap-4">
            {isOffline && (
              <span className="text-red-600 font-semibold flex items-center gap-1 text-sm animate-pulse">
                <Wifi className="w-4 h-4" />
                Offline
              </span>
            )}
            <div className="hidden sm:block">
              <UserIdentityDisplay />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-2 py-8 sm:px-4 sm:py-16 pb-32">
        <div className="max-w-2xl mx-auto">
          {/* Error Messages */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 shadow animate-shake flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="font-bold text-sm flex-1">{error}</div>
              {filesRef.current.length > 0 &&
                files.length > 0 &&
                !transferCompleteRef.current && (
                  <button
                    onClick={handleRetry}
                    className="w-full sm:w-auto bg-red-600 text-white py-2 px-4 rounded-lg hover:bg-red-700 transition-colors font-semibold shadow text-sm whitespace-nowrap"
                  >
                    Retry Transfer
                  </button>
                )}
            </div>
          )}

          {/* Resume Banner */}
          {resumeAvailable && (
            <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-sm">
              <div className="font-semibold text-sm">Connection interrupted</div>
              <button
                onClick={handleResume}
                disabled={resumeInProgress}
                className="w-full sm:w-auto bg-amber-500 text-white px-4 py-2 rounded hover:bg-amber-600 font-semibold disabled:opacity-50 transition-colors shadow text-sm"
              >
                {resumeInProgress ? "Resuming..." : "Resume Transfer"}
              </button>
            </div>
          )}

          {/* SELECT STEP */}
          {step === "select" && (
            <div className="bg-white/80 backdrop-blur-xl rounded-vxl sm:rounded-3xl shadow-2xl p-6 sm:p-10 border border-white/50 animate-fade-in">
              <div className="text-center mb-8">
                <div className="w-20 h-20 bg-linear-to-tr from-blue-400 to-purple-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg shadow-purple-500/20 animate-pop-in">
                  <Upload className="w-10 h-10 text-white" />
                </div>
                <div className="sm:hidden mb-6 flex justify-center">
                  <UserIdentityDisplay />
                </div>
                <h2 className="text-3xl font-black text-purple-900 mb-2 tracking-tight">
                  Send Files
                </h2>
                <p className="text-purple-600/70 text-base max-w-md mx-auto">
                  Select files or folders to share secure & fast with devices nearby.
                </p>
              </div>

              {/* Send as ZIP Option */}
              <div className="flex flex-col gap-1 mb-6 bg-blue-50/50 p-3 rounded-xl border border-blue-100">
                <div className="flex items-center gap-3">
                  <input
                    id="sendAsZip"
                    type="checkbox"
                    checked={sendAsZip}
                    onChange={(e) => setSendAsZip(e.target.checked)}
                    className="w-5 h-5 accent-purple-600 rounded cursor-pointer"
                  />
                  <div className="flex flex-col">
                    <label
                      htmlFor="sendAsZip"
                      className="text-sm font-bold text-gray-700 cursor-pointer"
                    >
                      Pack as ZIP Archive
                    </label>
                    <span className="text-xs text-gray-500">
                      Preserves folder structure and downloads as a single file.
                    </span>
                  </div>
                </div>
              </div>

              {/* File Selection Buttons */}
              <div className="flex flex-col sm:flex-row gap-4 mb-4">
                <label className="block flex-1 cursor-pointer group">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                  <div className="w-full bg-purple-600 text-white py-4 px-6 rounded-xl hover:bg-purple-700 transition-all font-bold shadow-lg shadow-purple-200 group-hover:scale-[1.02] flex items-center justify-center gap-2">
                    <Upload className="w-5 h-5" />
                    {files.length > 0 ? "Add Files" : "Select Files"}
                  </div>
                </label>

                <label className="block flex-1 cursor-pointer group">
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
                  <div className="w-full bg-white text-purple-900 border-2 border-purple-100 py-4 px-6 rounded-xl hover:border-purple-200 hover:bg-purple-50 transition-all font-bold group-hover:scale-[1.02] flex items-center justify-center gap-2">
                    <span className="text-2xl leading-none">📁</span>
                    {files.length > 0 ? "Add Folder" : "Select Folder"}
                  </div>
                </label>
              </div>

              {/* Nearby Devices Scanner - Moved up for better mobile visibility */}
              <NearbyDevices
                signaling={discoveryClient}
                deviceName={name || "Sender"}
                role="sender"
                onPair={handlePairDevice}
              />

              {/* Drag & Drop Zone */}
              <div
                className={`border-3 border-dashed rounded-2xl p-8 sm:p-12 text-center cursor-pointer transition-all duration-300 ${isDragActive
                  ? "border-purple-500 bg-purple-50 scale-[1.01] shadow-xl"
                  : "border-purple-100 hover:border-purple-300 hover:bg-purple-50/50"
                  }`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
              >
                <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 transition-colors ${isDragActive ? 'bg-purple-100' : 'bg-purple-100/50'}`}>
                  <Upload className={`w-8 h-8 ${isDragActive ? 'text-purple-600' : 'text-purple-300'}`} />
                </div>
                <p className="text-lg text-purple-800 mb-1 font-bold">
                  {files.length > 0
                    ? "Drop more files here"
                    : "Drag & Drop files here"}
                </p>
                <p className="text-xs text-purple-400 font-medium tracking-wide uppercase">Max 2GB per file</p>
              </div>

              {/* Selected Files Grid */}
              {files.length > 0 && (
                <div className="mt-8 animate-slide-up">
                  <div className="flex justify-between items-end mb-4 px-1">
                    <h3 className="text-lg font-bold text-gray-800">
                      Selected <span className="text-purple-600">{files.length}</span>
                    </h3>
                    <button
                      onClick={removeAllFiles}
                      className="text-xs font-bold text-red-500 hover:text-red-600 hover:underline px-2 py-1"
                    >
                      Clear All
                    </button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {files.map((f, idx) => {
                      const isImage = f.type.startsWith("image/");
                      const isVideo = f.type.startsWith("video/");
                      const isAudio = f.type.startsWith("audio/");

                      return (
                        <div
                          key={f.name + f.size + idx}
                          className="group relative bg-white rounded-xl p-3 flex flex-col items-center shadow-sm border border-gray-100 hover:shadow-md transition-all hover:border-purple-200"
                        >
                          <button
                            onClick={() => removeFile(idx)}
                            className="absolute -top-2 -right-2 bg-white text-red-500 rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-50 border border-gray-200 transition shadow-sm z-10 opacity-0 group-hover:opacity-100 scale-75 group-hover:scale-100"
                            aria-label="Remove file"
                          >
                            ×
                          </button>

                          {/* Image Preview */}
                          <div className="aspect-square w-full rounded-lg bg-gray-50 flex items-center justify-center mb-3 overflow-hidden">
                            {isImage ? (
                              <img
                                src={URL.createObjectURL(f)}
                                alt={f.name}
                                className="w-full h-full object-cover"
                                loading="lazy"
                                onLoad={(e) =>
                                  URL.revokeObjectURL(
                                    (e.target as HTMLImageElement).src
                                  )
                                }
                              />
                            ) : (
                              <span className="text-3xl opacity-50">
                                {isVideo ? '🎬' : isAudio ? '🎵' : '📄'}
                              </span>
                            )}
                          </div>

                          <span className="font-semibold text-purple-900 break-all text-center text-xs mb-0.5 line-clamp-2 w-full">
                            {f.name}
                          </span>
                          <span className="text-[10px] text-purple-400 font-medium">
                            {formatBytes(f.size)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

            </div>
          )}

          {/* CONNECTING STEP - New step for nearby device pairing */}
          {step === "connecting" && pairingMethod === "nearby" && (
            <div className="bg-white rounded-3xl shadow-2xl p-8 sm:p-12 text-center animate-fade-in border border-purple-100">
              <div className="relative w-24 h-24 mx-auto mb-6">
                <div className="absolute inset-0 bg-purple-200 rounded-full animate-ping opacity-20"></div>
                <div className="relative w-24 h-24 bg-gradient-to-tr from-purple-500 to-indigo-600 rounded-full flex items-center justify-center shadow-xl">
                  <Smartphone className="w-10 h-10 text-white" />
                </div>
              </div>

              <h2 className="text-3xl font-black text-purple-900 mb-2">
                Connecting to Device
              </h2>
              <p className="text-purple-600 font-medium mb-6">
                Establishing secure connection with
              </p>

              <div className="inline-flex items-center gap-3 bg-purple-50 px-6 py-3 rounded-full mb-8 border border-purple-100">
                <div className="w-10 h-10 bg-gradient-to-br from-purple-100 to-blue-100 rounded-full flex items-center justify-center">
                  <Smartphone className="w-5 h-5 text-purple-600" />
                </div>
                <span className="font-bold text-purple-900">{pairedDeviceName}</span>
              </div>

              {/* Show selected files preview */}
              {files.length > 0 && (
                <div className="bg-purple-50/80 rounded-xl p-4 border border-purple-100 max-w-sm mx-auto">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-purple-400 uppercase tracking-wider">Preparing to send</span>
                    <span className="text-xs font-bold text-purple-700 bg-white px-2 py-0.5 rounded-full shadow-sm">{files.length} files</span>
                  </div>
                  <div className="flex -space-x-2 overflow-hidden mb-2 justify-center">
                    {files.slice(0, 5).map((f, i) => (
                      <div key={i} className="inline-block h-8 w-8 rounded-full ring-2 ring-white bg-purple-100 flex items-center justify-center text-xs shadow-sm">
                        {f.type.startsWith('image') ? '🖼️' : '📄'}
                      </div>
                    ))}
                    {files.length > 5 && (
                      <div className="inline-block h-8 w-8 rounded-full ring-2 ring-white bg-purple-100 flex items-center justify-center text-[10px] font-bold text-purple-500">
                        +{files.length - 5}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-purple-500 font-medium">
                    Total size: {formatBytes(files.reduce((acc, f) => acc + f.size, 0))}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-center gap-2 mt-8">
                <div className="w-2.5 h-2.5 bg-purple-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-2.5 h-2.5 bg-purple-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-2.5 h-2.5 bg-purple-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
            </div>
          )}

          {/* WAITING STEP - Only show for QR code method */}
          {step === "waiting" && pairingMethod === "qr" && (
            <div className="bg-white rounded-3xl shadow-2xl p-6 sm:p-10 border border-purple-100">
              <div className="text-center mb-8">
                <div className="relative w-24 h-24 mx-auto mb-6">
                  <div className="absolute inset-0 bg-purple-100 rounded-full animate-ping opacity-20"></div>
                  <div className="relative w-24 h-24 bg-linear-to-tr from-purple-500 to-indigo-600 rounded-full flex items-center justify-center shadow-xl">
                    <Wifi className="w-10 h-10 text-white animate-pulse" />
                  </div>
                </div>

                <h2 className="text-3xl font-black text-purple-900 mb-2">
                  Ready to Send
                </h2>
                <p className="text-purple-600 font-medium">Scan QR code or open link on receiver</p>
              </div>

              {/* Show selected files preview */}
              {files.length > 0 && (
                <div className="bg-purple-50/80 rounded-xl p-4 mb-8 border border-purple-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-purple-400 uppercase tracking-wider">Sending</span>
                    <span className="text-xs font-bold text-purple-700 bg-white px-2 py-0.5 rounded-full shadow-sm">{files.length} files</span>
                  </div>
                  <div className="flex -space-x-2 overflow-hidden mb-2">
                    {files.slice(0, 5).map((f, i) => (
                      <div key={i} className="inline-block h-8 w-8 rounded-full ring-2 ring-white bg-purple-100 flex items-center justify-center text-xs shadow-sm">
                        {f.type.startsWith('image') ? '🖼️' : '📄'}
                      </div>
                    ))}
                    {files.length > 5 && (
                      <div className="inline-block h-8 w-8 rounded-full ring-2 ring-white bg-purple-50 flex items-center justify-center text-[10px] font-bold text-purple-500">
                        +{files.length - 5}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-purple-500 font-medium">
                    Total size: {formatBytes(files.reduce((acc, f) => acc + f.size, 0))}
                  </div>
                </div>
              )}

              <div className="bg-white border-2 border-indigo-100 rounded-2xl p-6 mb-8 flex flex-col items-center w-full max-w-xs sm:max-w-sm mx-auto shadow-sm">

                <div className="text-5xl font-mono font-bold text-indigo-600 text-center tracking-widest mb-6 select-all">
                  {sessionCode || "......"}
                </div>
                {sessionCode && (
                  <>
                    <div className="mb-6 flex flex-col items-center w-full bg-white p-2 rounded-xl">
                      <QRCode
                        value={`${typeof window !== "undefined"
                          ? window.location.origin
                          : ""
                          }/receive?code=${sessionCode}`}
                        size={200}
                        className="rounded-lg"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3 w-full">
                      <button
                        onClick={copyCode}
                        className="col-span-1 bg-indigo-50 text-indigo-700 py-3 rounded-xl hover:bg-indigo-100 transition-colors font-bold text-sm flex flex-col items-center justify-center gap-1"
                      >
                        <Copy className="w-4 h-4" />
                        {copyStatus === "code" ? "Copied" : "Copy Code"}
                      </button>
                      <button
                        onClick={copyLink}
                        className="col-span-1 bg-indigo-50 text-indigo-700 py-3 rounded-xl hover:bg-indigo-100 transition-colors font-bold text-sm flex flex-col items-center justify-center gap-1"
                      >
                        <LinkIcon className="w-4 h-4" />
                        {copyStatus === "link" ? "Copied" : "Copy Link"}
                      </button>
                    </div>
                    <button
                      onClick={() => {
                        const url = `${typeof window !== "undefined"
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
                      className="w-full mt-3 bg-indigo-600 text-white py-3 px-4 rounded-xl hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2 font-bold shadow-lg shadow-indigo-200"
                    >
                      Share Link
                    </button>
                  </>
                )}
              </div>

              <p className="text-center text-xs text-gray-400 font-medium">
                Code expires in 5 minutes • Keep this tab open
              </p>
            </div>
          )}

          {/* CONNECTED STEP */}
          {step === "connected" && (
            <div className="bg-white rounded-3xl shadow-xl p-8 sm:p-12 text-center animate-fade-in">
              <div className="w-24 h-24 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6 animate-pulse">
                <Check className="w-10 h-10 text-green-600" />
              </div>
              <h2 className="text-3xl font-black text-purple-900 mb-2">
                Connected!
              </h2>
              <p className="text-purple-700 font-medium">
                {pairingMethod === "nearby" && pairedDeviceName
                  ? `Connected to ${pairedDeviceName}`
                  : "Secure handshake established"}
              </p>
            </div>
          )}

          {/* TRANSFERRING STEP */}
          {step === "transferring" && (
            <div className="bg-white rounded-3xl shadow-xl p-6 sm:p-10 border border-purple-100">
              <div className="flex items-center justify-between mb-8">
                <h2 className="text-2xl font-black text-purple-900">
                  Sending Files...
                </h2>
                <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></div>
              </div>

              <div className="space-y-4">
                {files.map((f, idx) => {
                  const progress = progressList[idx] || 0;
                  const isComplete = progress === 100;

                  return (
                    <div
                      key={f.name + f.size}
                      className="bg-purple-50/50 rounded-xl p-4 border border-purple-100"
                    >
                      <div className="flex justify-between items-center mb-3">
                        <div className="flex items-center gap-3 overflow-hidden">
                          <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${isComplete ? 'bg-green-100 text-green-600' : 'bg-purple-100 text-purple-600'}`}>
                            {isComplete ? <Check className="w-5 h-5" /> : <Upload className="w-5 h-5" />}
                          </div>
                          <div className="min-w-0">
                            <div className="font-bold text-purple-900 text-sm truncate">{f.name}</div>
                            <div className="text-xs text-purple-500">{formatBytes(f.size)}</div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-bold text-purple-900">{Math.round(progress)}%</div>
                          <div className="text-xs text-purple-500/70 font-mono">{formatSpeed(speedList[idx] || 0)}</div>
                        </div>
                      </div>

                      <div className="w-full h-2 bg-purple-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all duration-300 ease-out rounded-full ${isComplete ? 'bg-green-500' : 'bg-purple-600'}`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* COMPLETE STEP */}
          {step === "complete" && (
            <div className="bg-white rounded-3xl shadow-2xl p-8 sm:p-12 text-center animate-pop-in">
              <div className="w-24 h-24 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <Check className="w-12 h-12 text-green-600" />
              </div>
              <h2 className="text-3xl font-black text-purple-900 mb-2">
                All Done!
              </h2>
              <p className="text-purple-700 mb-8 font-medium">
                Successfully sent {files.length} {files.length === 1 ? 'file' : 'files'}.
              </p>
              <button
                onClick={reset}
                className="w-full bg-purple-700 text-white py-4 px-6 rounded-xl hover:bg-purple-800 transition-colors font-bold shadow-lg"
              >
                Send More Files
              </button>
            </div>
          )}
        </div>
      </main>

      {/* FLOATING ACTION BAR */}
      {files.length > 0 && step === "select" && (
        <div className="fixed bottom-0 left-0 right-0 z-30 bg-white/80 backdrop-blur-xl border-t border-purple-100 shadow-[0_-5px_20px_-5px_rgba(0,0,0,0.1)] animate-slide-up">
          <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between gap-4">
            <div className="flex flex-col min-w-0">
              <span className="font-bold text-purple-950 text-sm">
                {files.length} {files.length === 1 ? "file" : "files"} selected
              </span>
              <span className="text-xs text-purple-600 truncate font-medium">
                Total size: {formatBytes(files.reduce((acc, f) => acc + f.size, 0))}
              </span>
            </div>
            <button
              onClick={handleSend}
              disabled={!readyToSend}
              className="bg-purple-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-purple-700 transition-colors disabled:bg-purple-100 disabled:text-purple-300 disabled:cursor-not-allowed shadow-lg hover:shadow-purple-200 flex items-center gap-2 whitespace-nowrap active:scale-95 transform"
            >
              Send Now
              <User className="w-4 h-4 ml-1 opacity-70" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
