import { useState, useEffect } from 'react';
import { useDiscovery } from '../hooks/useDiscovery';
import { Laptop, Phone, Monitor, Check, User } from 'lucide-react';

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

  if (peers.length === 0 && !isDiscovering) return null;

  return (
    <div className="mt-8 pt-8 border-t border-gray-100 animate-fade-in">
      <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
        {isDiscovering && <span className="animate-spin">⟳</span>}
        Nearby Devices {peers.length > 0 && <span className="bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full text-xs">{peers.length}</span>}
      </h3>
      
      {peers.length === 0 ? (
         <div className="text-gray-400 text-sm py-4 italic text-center">
            Scanning for devices on your network...
         </div>
      ) : (
        <div className="grid gap-3">
          {peers.map((peer) => (
            <button
              key={peer.id}
              onClick={() => onPair(peer)}
              className="flex items-center gap-3 p-3 bg-white border border-gray-200 rounded-xl hover:border-purple-400 hover:shadow-md transition-all group text-left w-full"
            >
              <div className="w-10 h-10 bg-gray-50 rounded-full flex items-center justify-center group-hover:bg-purple-50 transition-colors">
                <Monitor className="w-5 h-5 text-gray-500 group-hover:text-purple-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 truncate">{peer.name || 'Unknown Device'}</div>
                <div className="text-xs text-gray-500 truncate">{peer.model || peer.type}</div>
              </div>
              <div className="text-xs font-medium text-purple-600 opacity-0 group-hover:opacity-100 transition-opacity">
                {role === 'sender' ? 'Send' : 'Pair'} →
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
