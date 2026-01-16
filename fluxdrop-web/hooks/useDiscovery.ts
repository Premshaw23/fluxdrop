import { useState, useEffect, useCallback, useRef } from 'react';
import { SignalingClient } from '../lib/signaling/SignalingClient';
import { useUserStore } from '../lib/store';

export interface DiscoveredDevice {
  id: string;
  name: string;
  type: string;
  model?: string;
  online: boolean; // Just for UI state, backend doesn't send this explicitly usually
}

interface UseDiscoveryProps {
  signaling: SignalingClient | null;
  deviceName: string;
  deviceType: string;
}

export function useDiscovery({ signaling, deviceName, deviceType }: UseDiscoveryProps) {
  const [peers, setPeers] = useState<DiscoveredDevice[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  
  // Ref to track if we are currently mounting/unmounting
  const mountedRef = useRef(true);

  // Handle incoming discovery messages
  useEffect(() => {
    if (!signaling) return;

    const handlePeers = (message: any) => {
      if (mountedRef.current) {
        const sortedPeers = [...(message.peers || [])].sort((a, b) => {
          // Sort by name first for visual stability
          const nameCompare = (a.name || "").localeCompare(b.name || "");
          if (nameCompare !== 0) return nameCompare;
          // Then by ID as fallback
          return a.id.localeCompare(b.id);
        });
        
        console.log(`📡 Discovery: Found ${sortedPeers.length} peers (Sorted)`, sortedPeers);
        setPeers(sortedPeers);
        setIsDiscovering(false); 
      }
    };

    const handleAnnounced = (message: any) => {
      // Confirmation that we are announced, maybe trigger a refresh?
      // For now just log it
      console.log('✅ Device announced successfully:', message.device);
    };

    const handleError = (message: any) => {
      console.error('❌ Discovery Error:', message.error);
    };

    signaling.on('discovery:peers', handlePeers);
    signaling.on('discovery:announced', handleAnnounced);
    signaling.on('error', handleError);

    return () => {
      signaling.off('discovery:peers', handlePeers);
      signaling.off('discovery:announced', handleAnnounced);
      signaling.off('error', handleError);
    };
  }, [signaling]);

  // Periodic announcement (Heartbeat) & Polling
  useEffect(() => {
    if (!signaling) return;

    const { deviceId } = useUserStore.getState();

    const announceAndPoll = () => {
      if (!signaling.isConnected()) return;

      // 1. Announce Self
      signaling.announceDevice({
        id: deviceId,
        name: deviceName,
        type: deviceType,
        model: navigator.platform
      });

      // 2. Ask for others
      setIsDiscovering(true);
      signaling.discoverDevices();
    };

    // Initial run when connected
    if (signaling.isConnected()) {
      announceAndPoll();
    } 
    // If not connected, we rely on the main connection logic, 
    // BUT we should also listen for 'open' event if we passed the client before it opened.
    // However, assuming the parent component handles connection state, we can just poll.

    const interval = setInterval(announceAndPoll, 5000); // 5s heartbeat

    return () => clearInterval(interval);
  }, [signaling, deviceName, deviceType]);

  return { peers, isDiscovering };
}
