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
    deviceType: role // Announce as sender or receiver
  });

  // Filter to show the opposite role and deduplicate by ID
  const filteredPeers = Array.from(
    new Map(
      peers
        .filter(peer => {
          if (role === 'sender') return peer.type === 'receiver';
          if (role === 'receiver') return peer.type === 'sender';
          return false;
        })
        .map(peer => [peer.id, peer])
    ).values()
  );

  const getDeviceIcon = (type: string) => {
    switch (type?.toLowerCase()) {
      case 'mobile': return <Smartphone className="w-5 h-5" />;
      case 'tablet': return <Tablet className="w-5 h-5" />;
      default: return <Monitor className="w-5 h-5" />;
    }
  };

  if (!signaling) {
    return (
      <div className="mt-8 py-5 border-t-2 border-purple-100 animate-fade-in bg-gradient-to-br from-white to-purple-50/30 backdrop-blur-sm rounded-2xl p-3 shadow-md">
        <div className="flex items-center gap-2 mb-4">
          <div className="h-3 w-3 rounded-full bg-purple-300 animate-pulse"></div>
          <h3 className="text-sm font-bold text-purple-400 uppercase tracking-wide">Initializing Nearby Search...</h3>
        </div>
        <div className="bg-white/50 rounded-2xl p-8 text-center border-2 border-dashed border-purple-100">
          <div className="w-8 h-8 border-2 border-purple-200 border-t-purple-500 animate-spin rounded-full mx-auto mb-3"></div>
          <p className="text-purple-400 text-sm font-medium">Connecting to signaling server...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8 py-5 border-t-2 border-purple-100 animate-fade-in bg-gradient-to-br from-white to-purple-50/30 backdrop-blur-sm rounded-2xl p-3 shadow-md">
      <h3 className="text-sm font-bold text-purple-900 uppercase tracking-wide mb-5 flex items-center gap-2">
        {isDiscovering ? (
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-500 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-purple-600"></span>
          </span>
        ) : (
          <div className="h-3 w-3 rounded-full bg-green-500 shadow-sm border-2 border-white"></div>
        )}
        {role === 'sender' ? 'Nearby Receivers' : 'Nearby Senders'}
        {role === 'receiver' && <span className="ml-2 text-[10px] font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full border border-green-100 animate-pulse">Listening for nearby senders</span>}
        {filteredPeers.length > 0 && <span className="bg-purple-600 text-white px-2.5 py-0.5 rounded-full text-xs font-bold shadow-sm ml-auto">{filteredPeers.length}</span>}
      </h3>

      {filteredPeers.length === 0 ? (
        <div className="bg-white/50 rounded-2xl p-8 text-center border-2 border-dashed border-purple-200 shadow-sm transition-all">
          <div className="flex justify-center mb-3">
            <div className={`h-12 w-12 bg-gradient-to-br from-purple-100 to-blue-50 rounded-full flex items-center justify-center shadow-inner`}>
              {isDiscovering ? (
                <div className="w-6 h-6 rounded-full border-3 border-purple-200 border-t-purple-600 animate-spin"></div>
              ) : (
                <Smartphone className="w-6 h-6 text-purple-300 animate-bounce" />
              )}
            </div>
          </div>
          <p className="text-purple-900 text-sm font-bold">
            {isDiscovering ? 'Searching for devices...' : 'No devices found nearby'}
          </p>
          <p className="text-xs text-purple-500/70 mt-1 max-w-[200px] mx-auto">
            {isDiscovering
              ? 'Looking for active FluxDrop nodes on your network'
              : 'Make sure FluxDrop is open on the other device and connected to the same network'}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {filteredPeers.map((peer) => (
            role === 'receiver' ? (
              <div
                key={peer.id}
                className="relative overflow-hidden flex items-center gap-4 p-3 bg-white border-2 border-purple-100 rounded-2xl shadow-sm transition-all duration-200 w-full"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-purple-50/30 to-blue-50/20 opacity-100"></div>
                <div className="relative w-12 h-12 bg-gradient-to-br from-purple-100 to-blue-100 rounded-xl flex items-center justify-center text-purple-600 shadow-sm shrink-0">
                  {getDeviceIcon(peer.type)}
                </div>
                <div className="relative flex-1 min-w-0">
                  <div className="font-bold text-purple-900 truncate text-sm">
                    {peer.name || 'Unknown Device'}
                  </div>
                  <div className="text-[10px] text-purple-500 truncate font-semibold uppercase tracking-wider mt-0.5">
                    Sender nearby
                  </div>
                </div>
                <div className="relative flex items-center gap-1.5 px-3 py-1 bg-purple-50 rounded-full border border-purple-100">
                  <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
                  <span className="text-[10px] font-bold text-purple-600 uppercase">Online</span>
                </div>
              </div>
            ) : (
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
                  <div className="font-bold text-purple-900 truncate text-base group-hover:text-purple-700 transition-colors">
                    {peer.name || 'Unknown Device'}
                  </div>
                  <div className="text-xs text-purple-700 truncate font-medium mt-0.5">
                    {peer.model || 'Ready to receive'}
                  </div>
                </div>

                {/* Arrow - always visible on mobile, animated on hover */}
                <div className="relative flex items-center justify-center w-9 h-9 rounded-full bg-purple-600 text-white shadow-md group-hover:bg-purple-700 group-hover:shadow-lg transition-all">
                  <div className="sr-only">Send to this device</div>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </div>
              </button>
            )
          ))}
        </div>
      )}
    </div>
  );
}