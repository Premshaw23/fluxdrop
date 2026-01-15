import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface QRScannerModalProps {
  onResult: (text: string) => void;
  onClose: () => void;
}

export default function QRScannerModal({ onResult, onClose }: QRScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<any>(null);

  useEffect(() => {
    let active = true;

    import('@zxing/browser').then(({ BrowserMultiFormatReader }) => {
      if (!active || !videoRef.current) return;

      const reader = new BrowserMultiFormatReader();

      reader
        .decodeFromVideoDevice(undefined, videoRef.current!, (result) => {
          if (!active) return;

          if (result) {
            onResult(result.getText());
            controlsRef.current?.stop();
            onClose();
          }
        })
        .then((controls) => {
          controlsRef.current = controls;
        })
        .catch((err) => {
          console.error('Camera error:', err);
        });
    });

    return () => {
      active = false;
      controlsRef.current?.stop();
    };
  }, [onResult, onClose]);

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div 
        className="relative bg-white rounded-2xl shadow-2xl max-w-sm w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 bg-white/90 hover:bg-white rounded-full transition-colors shadow-lg"
          aria-label="Close scanner"
        >
          <X className="w-5 h-5 text-gray-700" />
        </button>

        {/* Scanner Area */}
        <div className="p-6">
          <h2 className="text-2xl font-bold text-purple-600 mb-2 text-center">
            Scan QR Code
          </h2>
          <p className="text-gray-600 text-sm mb-6 text-center">
            Position the QR code in the frame
          </p>

          <div className="relative aspect-square bg-gray-900 rounded-xl overflow-hidden">
            <video 
              ref={videoRef} 
              className="w-full h-full object-cover"
            />
            
            {/* Simple Corner Overlay */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <div className="relative w-3/4 h-3/4">
                {/* Corners */}
                <div className="absolute top-0 left-0 w-8 h-8 border-t-3 border-l-3 border-purple-400"></div>
                <div className="absolute top-0 right-0 w-8 h-8 border-t-3 border-r-3 border-purple-400"></div>
                <div className="absolute bottom-0 left-0 w-8 h-8 border-b-3 border-l-3 border-purple-400"></div>
                <div className="absolute bottom-0 right-0 w-8 h-8 border-b-3 border-r-3 border-purple-400"></div>
              </div>
            </div>
          </div>

          <p className="text-center text-xs text-gray-500 mt-4">
            Camera will scan automatically
          </p>
        </div>
      </div>

      <style jsx>{`
        .border-t-3 {
          border-top-width: 3px;
        }
        .border-l-3 {
          border-left-width: 3px;
        }
        .border-r-3 {
          border-right-width: 3px;
        }
        .border-b-3 {
          border-bottom-width: 3px;
        }
      `}</style>
    </div>
  );
}