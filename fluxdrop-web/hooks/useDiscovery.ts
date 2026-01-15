import { useState, useEffect, useCallback, useRef } from 'react';
import { SignalingClient } from '../lib/signaling/SignalingClient';

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
        setPeers(message.peers || []);
        setIsDiscovering(false); // Stop loading spinner if used
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
      signaling.off('discovery:peers');
      signaling.off('discovery:announced');
      signaling.off('error');
    };
  }, [signaling]);

  // Periodic announcement (Heartbeat) & Polling
  useEffect(() => {
    if (!signaling) return;

    const announceAndPoll = () => {
      if (!signaling.isConnected()) return;

      // 1. Announce Self
      signaling.announceDevice({
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

    const interval = setInterval(announceAndPoll, 10000); // 10s heartbeat

    return () => clearInterval(interval);
  }, [signaling, deviceName, deviceType]);

  return { peers, isDiscovering };
}
