/**
 * UDP discovery for Clearlight sauna on the local network.
 * Broadcasts on port 12414, listens for responses on port 2415.
 *
 * After discovery returns an IP, use getMacAddress() to resolve the hardware MAC.
 * The MAC is populated automatically on DiscoveredDevice when available.
 */

import * as dgram from 'dgram';
import { exec } from 'child_process';
import { promisify } from 'util';
import { UDP_BROADCAST_PORT, Command, buildFrame, parseFrame } from './protocol';

const execAsync = promisify(exec);

export interface DiscoveredDevice {
  ip: string;
  port: number;
  did: string;
  mac: string | null; // populated after getMacAddress() or enrichDiscovery()
}

/**
 * Resolve the MAC address for a given IP using the local ARP cache.
 * Works on macOS and Linux. Returns null if the IP is not in the ARP cache
 * or the platform is unsupported.
 *
 * The ARP entry is usually populated automatically after the device responds
 * to a UDP broadcast, since the OS records the sender's L2 address.
 */
export async function getMacAddress(ip: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`arp -n ${ip}`, { timeout: 3000 });
    const match = stdout.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
    if (!match) return null;
    // Normalise to colon-separated lowercase
    return match[0].toLowerCase().replace(/-/g, ':');
  } catch {
    return null;
  }
}

// --- Core discovery ---

function runDiscovery(timeoutMs: number, stopOnFirst: boolean): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const devices: DiscoveredDevice[] = [];
    const seen = new Set<string>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;

    const done = () => {
      if (finished) return;
      finished = true;
      try { socket.close(); } catch { /* ignore */ }
      resolve(devices);
    };

    setTimeout(done, timeoutMs);

    socket.on('message', (msg, rinfo) => {
      const result = parseFrame(msg);
      if (!result || result.frame.command !== Command.DISCOVER_RESPONSE) return;

      const did = result.frame.payload.toString('ascii').replace(/\0/g, '');
      if (seen.has(did)) return;
      seen.add(did);

      devices.push({ ip: rinfo.address, port: rinfo.port, did, mac: null });
      if (stopOnFirst) done();
    });

    socket.on('error', done);

    socket.bind(0, () => {
      socket.setBroadcast(true);
      const frame = buildFrame(Command.DISCOVER_REQUEST);
      socket.send(frame, 0, frame.length, UDP_BROADCAST_PORT, '255.255.255.255');
    });
  });
}

/**
 * Discover the first Clearlight sauna on the local network.
 */
export function discoverSauna(timeoutMs = 5000): Promise<DiscoveredDevice | null> {
  return runDiscovery(timeoutMs, true).then((d) => d[0] ?? null);
}

/**
 * Discover all Clearlight saunas on the local network.
 */
export function discoverAllSaunas(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
  return runDiscovery(timeoutMs, false);
}

/**
 * Discover all saunas and enrich each result with its MAC address via ARP.
 * Use this when you need MAC addresses (e.g. for the CLI discover command or initial setup).
 */
export async function discoverWithMac(timeoutMs = 5000): Promise<DiscoveredDevice[]> {
  const devices = await discoverAllSaunas(timeoutMs);
  await Promise.all(
    devices.map(async (d) => {
      d.mac = await getMacAddress(d.ip);
    }),
  );
  return devices;
}

/**
 * Find a sauna by its MAC address.
 * Runs discovery, then ARP-resolves each responding IP and compares.
 * MAC comparison is case-insensitive; separators (: or -) are normalised.
 */
export async function discoverByMac(targetMac: string, timeoutMs = 8000): Promise<DiscoveredDevice | null> {
  const normalised = targetMac.toLowerCase().replace(/-/g, ':');
  const devices = await discoverAllSaunas(timeoutMs);

  for (const d of devices) {
    const mac = await getMacAddress(d.ip);
    if (mac && mac === normalised) {
      d.mac = mac;
      return d;
    }
  }
  return null;
}

/**
 * Find a sauna by its Gizwits device ID (did).
 * The did is a stable hardware identifier present in every discovery response.
 */
export async function discoverByDid(targetDid: string, timeoutMs = 8000): Promise<DiscoveredDevice | null> {
  const devices = await discoverAllSaunas(timeoutMs);
  return devices.find((d) => d.did === targetDid) ?? null;
}
