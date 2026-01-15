interface Device {
    id: string;
    name: string;
    type: string;
    model?: string;
}
export declare class DiscoveryService {
    private redis;
    private readonly PREFIX;
    private readonly REFRESH_TTL;
    constructor();
    /**
     * Announce a device's presence to its public IP group
     */
    announceDevice(ip: string, device: Device): Promise<void>;
    /**
     * Get all active devices on the same public IP
     */
    getPeers(ip: string): Promise<Device[]>;
    /**
     * Explicitly remove a device (e.g. on disconnect)
     */
    removeDevice(ip: string, deviceId: string): Promise<void>;
    shutdown(): Promise<void>;
}
export {};
//# sourceMappingURL=discovery.d.ts.map