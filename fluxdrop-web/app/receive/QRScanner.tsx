'use client';

import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { useEffect, useRef } from 'react';

export default function QRScanner({
  onResult,
}: {
  onResult: (text: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);

  useEffect(() => {
    const reader = new BrowserMultiFormatReader();
    let active = true;

    reader
      .decodeFromVideoDevice(
        undefined,
        videoRef.current!,
        (result) => {
          if (!active) return;

          if (result) {
            onResult(result.getText());

            // ✅ stop camera after first scan
            controlsRef.current?.stop();
          }
        }
      )
      .then((controls) => {
        controlsRef.current = controls;
      });

    return () => {
      active = false;
      controlsRef.current?.stop();
    };
  }, [onResult]);

  return <video ref={videoRef} className="w-full rounded-lg" />;
}
