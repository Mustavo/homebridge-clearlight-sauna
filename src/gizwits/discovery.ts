/**
 * UDP discovery for Clearlight sauna on the local network.
 * Broadcasts on port 12414, listens for responses on port 2415.
 */

import * as dgram from 'dgram';
import { UDP_BROADCAST_PORT, Command, buildFrame, parseFrame } from './protocol';

export interface DiscoveredDevice {
  ip: string;
  port: number;
  did: string;
}

/**
 * Discover Clearlight saunas on the local network.
 * Returns the first device found within the timeout period.
 */
export function discoverSauna(timeoutMs = 5000): Promise<DiscoveredDevice | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        try { socket.close(); } catch { /* ignore */ }
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    socket.on('message', (msg, rinfo) => {
      const result = parseFrame(msg);
      if (result && result.frame.command === Command.DISCOVER_RESPONSE) {
        clearTimeout(timer);
        const did = result.frame.payload.toString('ascii').replace(/\0/g, '');
        cleanup();
        resolve({ ip: rinfo.address, port: rinfo.port, did });
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      cleanup();
      resolve(null);
    });

    socket.bind(0, () => {
      socket.setBroadcast(true);
      const frame = buildFrame(Command.DISCOVER_REQUEST);
      socket.send(frame, 0, frame.length, UDP_BROADCAST_PORT, '255.255.255.255');
    });
  });
}
