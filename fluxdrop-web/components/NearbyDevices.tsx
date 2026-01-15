import { useState, useEffect } from 'react';
import { useDiscovery } from '../hooks/useDiscovery';
import { Laptop, Phone, Monitor, Check, User, Smartphone, Tablet } from 'lucide-react';

interface NearbyDevicesProps {
  signaling: any;
  deviceName: string;
  onPair: (device: any) => void;
  role: 'sender' | 'receiver';
}

export default function NearbyDevices({ signaling, deviceName, onPair, role }: NearbyDevicesProps) {
  const { peers, isDiscovering } = useDiscovery({
    signaling,
    deviceName,
    deviceType: 'browser'
  });

  // Filter to only show receiver devices
  const receiverPeers = peers.filter(peer => peer.type === 'receiver');

  const getDeviceIcon = (type: string) => {
    switch (type?.toLowerCase()) {
      case 'mobile': return <Smartphone className="w-5 h-5" />;
      case 'tablet': return <Tablet className="w-5 h-5" />;
      default: return <Monitor className="w-5 h-5" />;
    }
  };

  if (receiverPeers.length === 0 && !isDiscovering) return null;

  return (
    <div className="mt-8 py-5 border-t-2 border-gray-200 animate-fade-in bg-gradient-to-br from-white to-purple-50/30 backdrop-blur-sm rounded-2xl p-3 shadow-md">
      <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-5 flex items-center gap-2">
        {isDiscovering ? (
           <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-500 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-purple-600"></span>
            </span>
        ) : (
            <div className="h-3 w-3 rounded-full bg-green-500 shadow-sm"></div>
        )}
        Nearby Receivers {receiverPeers.length > 0 && <span className="bg-purple-600 text-white px-2.5 py-0.5 rounded-full text-xs font-bold shadow-sm">{receiverPeers.length}</span>}
      </h3>
      
      {receiverPeers.length === 0 ? (
         <div className="bg-white rounded-2xl p-8 text-center border-2 border-dashed border-purple-300 shadow-sm">
            <div className="animate-pulse flex justify-center mb-3">
                <div className="h-10 w-10 bg-gradient-to-br from-purple-100 to-purple-200 rounded-full"></div>
            </div>
            <p className="text-gray-600 text-sm font-semibold">Scanning for receivers nearby...</p>
         </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {receiverPeers.map((peer) => (
            <button
              key={peer.id}
              onClick={() => onPair(peer)}
              className="relative overflow-hidden flex items-center gap-4 p-3 bg-white border-2 border-purple-200 rounded-2xl shadow-md hover:shadow-xl hover:border-purple-400 active:scale-98 transition-all duration-200 group text-left w-full"
            >
              {/* Always visible gradient background */}
              <div className="absolute inset-0 bg-gradient-to-r from-purple-50/50 via-blue-50/30 to-purple-50/50 opacity-100 group-hover:opacity-100 transition-opacity"></div>
              
              {/* Icon container - always colored */}
              <div className="relative w-14 h-14 bg-gradient-to-br from-purple-100 to-blue-100 rounded-2xl flex items-center justify-center text-purple-600 group-hover:from-purple-200 group-hover:to-blue-200 transition-all shadow-sm">
                {getDeviceIcon(peer.type)}
              </div>
              
              {/* Device info */}
              <div className="relative flex-1 min-w-0">
                <div className="font-bold text-gray-900 truncate text-base group-hover:text-purple-700 transition-colors">
                    {peer.name || 'Unknown Device'}
                </div>
                <div className="text-xs text-gray-600 truncate font-medium mt-0.5">
                    {peer.model || 'Ready to receive'}
                </div>
              </div>
              
              {/* Arrow - always visible on mobile, animated on hover */}
              <div className="relative flex items-center justify-center w-9 h-9 rounded-full bg-purple-600 text-white shadow-md group-hover:bg-purple-700 group-hover:shadow-lg transition-all">
                 <div className="sr-only">Send to this device</div>
                 <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                 </svg>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}