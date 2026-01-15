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

  const getDeviceIcon = (type: string) => {
    switch (type?.toLowerCase()) {
      case 'mobile': return <Smartphone className="w-5 h-5" />;
      case 'tablet': return <Tablet className="w-5 h-5" />;
      default: return <Monitor className="w-5 h-5" />;
    }
  };

  if (peers.length === 0 && !isDiscovering) return null;

  return (
    <div className="mt-8 pt-8 border-t border-gray-100/50 animate-fade-in">
      <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
        {isDiscovering ? (
           <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500"></span>
            </span>
        ) : (
            <div className="h-2 w-2 rounded-full bg-green-500"></div>
        )}
        Nearby Devices {peers.length > 0 && <span className="bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full text-[10px] font-bold">{peers.length}</span>}
      </h3>
      
      {peers.length === 0 ? (
         <div className="bg-white/50 rounded-xl p-6 text-center border border-dashed border-gray-200">
            <div className="animate-pulse flex justify-center mb-2">
                <div className="h-8 w-8 bg-gray-100 rounded-full"></div>
            </div>
            <p className="text-gray-400 text-sm font-medium">Scanning for devices nearby...</p>
         </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {peers.map((peer) => (
            <button
              key={peer.id}
              onClick={() => onPair(peer)}
              className="relative overflow-hidden flex items-center gap-3 p-3 bg-white border border-gray-100 rounded-2xl hover:border-purple-400 hover:shadow-lg hover:shadow-purple-100/50 transition-all duration-300 group text-left w-full"
            >
              <div className="absolute inset-0 bg-linear-to-r from-purple-50/0 via-purple-50/0 to-purple-50/50 opacity-0 group-hover:opacity-100 transition-opacity"></div>
              
              <div className="relative w-12 h-12 bg-gray-50 rounded-2xl flex items-center justify-center group-hover:bg-purple-100 group-hover:text-purple-600 transition-colors shadow-inner">
                {getDeviceIcon(peer.type)}
              </div>
              
              <div className="relative flex-1 min-w-0">
                <div className="font-bold text-gray-800 truncate group-hover:text-purple-700 transition-colors">
                    {peer.name || 'Unknown Device'}
                </div>
                <div className="text-xs text-gray-500 truncate font-medium">
                    {peer.model || (peer.type === 'mobile' ? 'Mobile' : 'Desktop')}
                </div>
              </div>
              
              <div className="relative flex items-center justify-center w-8 h-8 rounded-full bg-gray-50 text-gray-300 group-hover:bg-purple-500 group-hover:text-white transition-all transform translate-x-2 opacity-0 group-hover:opacity-100 group-hover:translate-x-0">
                 <div className="sr-only">{role === 'sender' ? 'Send' : 'Pair'}</div>
                 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
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
