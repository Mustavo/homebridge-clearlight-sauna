/**
 * Clearlight Sauna dynamic platform plugin.
 * Discovers saunas on the LAN and registers each as a cached accessory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { SaunaAccessoryHandler } from './sauna-accessory';
import { discoverAllSaunas } from './gizwits/discovery';
import type { DiscoveredDevice } from './gizwits/discovery';

const PLUGIN_NAME = 'homebridge-clearlight-sauna';
const PLATFORM_NAME = 'ClearlightSauna';

interface DeviceConfig {
  /** Preferred: hardware MAC address (aa:bb:cc:dd:ee:ff). Survives DHCP lease changes. */
  mac?: string;
  /** Alternative: Gizwits device ID from discover command output. Also stable across IP changes. */
  did?: string;
  /** Deprecated: static IP address. Use mac or did instead. */
  host?: string;
  name?: string;
  minTemp?: number;
  maxTemp?: number;
  defaultTemp?: number;
  internalLightName?: string;
  externalLightName?: string;
  atTempSensor?: boolean;
}

export { PLUGIN_NAME, PLATFORM_NAME };

export class SaunaPlatform implements DynamicPlatformPlugin {
  private readonly cachedAccessories: Map<string, PlatformAccessory> = new Map();
  private readonly handlers: Map<string, SaunaAccessoryHandler> = new Map();
  private readonly discoveryTimeout: number;
  private readonly discoveryInterval: number;
  private readonly devices: DeviceConfig[];
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly statePath: string;

  constructor(
    private readonly log: Logging,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    this.discoveryTimeout = (config.discoveryTimeout ?? 5) * 1000;
    this.discoveryInterval = (config.discoveryInterval ?? 60) * 1000;
    this.devices = (config.devices as DeviceConfig[]) ?? [];
    const storagePath = process.env['UIX_STORAGE_PATH'] ?? path.join(os.homedir(), '.homebridge');
    this.statePath = path.join(storagePath, 'clearlightsauna-state.json');

    this.api.on('didFinishLaunching', () => {
      this.log.info('Clearlight Sauna platform starting');
      this.setupPinnedDevices();
      this.runDiscovery();
      this.discoveryTimer = setInterval(() => this.runDiscovery(), this.discoveryInterval);
    });

    this.api.on('shutdown', () => {
      if (this.discoveryTimer) {
        clearInterval(this.discoveryTimer);
        this.discoveryTimer = null;
      }
      for (const handler of this.handlers.values()) {
        handler.destroy();
      }
    });
  }

  private writeDeviceState(info: { mac: string | null; did: string | null; ip: string; name: string }): void {
    const key = info.mac ?? info.did ?? info.ip;
    try {
      let state: Record<string, unknown> = {};
      try { state = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { /* first run */ }
      state[key] = { name: info.name, ip: info.ip, mac: info.mac, did: info.did, lastSeen: new Date().toISOString() };
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    } catch (err) {
      this.log.debug('Could not write device state: %s', (err as Error).message);
    }
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring cached accessory: %s', accessory.displayName);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private setupPinnedDevices(): void {
    for (const deviceConfig of this.devices) {
      // UUID is keyed on the most stable identifier available
      const stableKey = deviceConfig.mac
        ? 'mac-' + deviceConfig.mac.toLowerCase().replace(/-/g, ':')
        : deviceConfig.did
          ? 'did-' + deviceConfig.did
          : 'host-' + (deviceConfig.host ?? 'unknown');

      const uuid = this.api.hap.uuid.generate('clearlight-' + stableKey);
      const name = deviceConfig.name ?? 'Sauna';
      const identLabel = deviceConfig.mac ?? deviceConfig.did ?? deviceConfig.host ?? 'auto';

      let accessory = this.cachedAccessories.get(uuid);
      if (!accessory) {
        this.log.info('Adding configured sauna: %s (%s)', name, identLabel);
        accessory = new this.api.platformAccessory(name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(uuid, accessory);
      }

      if (!this.handlers.has(uuid)) {
        const handler = new SaunaAccessoryHandler(this.log, accessory, this.api, {
          mac: deviceConfig.mac,
          did: deviceConfig.did,
          host: deviceConfig.host,
          minTemp: deviceConfig.minTemp,
          maxTemp: deviceConfig.maxTemp,
          defaultTemp: deviceConfig.defaultTemp,
          internalLightName: deviceConfig.internalLightName,
          externalLightName: deviceConfig.externalLightName,
          atTempSensor: deviceConfig.atTempSensor,
          onAuthenticated: (info) => this.writeDeviceState(info),
        });
        this.handlers.set(uuid, handler);
      }
    }
  }

  private async runDiscovery(): Promise<void> {
    this.log.debug('Running sauna discovery (%dms timeout)', this.discoveryTimeout);

    let discovered: DiscoveredDevice[];
    try {
      discovered = await discoverAllSaunas(this.discoveryTimeout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('Discovery failed: %s', msg);
      return;
    }

    this.log.debug('Discovery found %d sauna(s)', discovered.length);

    const matchedUuids = new Set<string>();

    for (const device of discovered) {
      if (!device.did) {
        this.log.warn('Ignoring discovery response with empty device ID (malformed payload)');
        continue;
      }

      const uuid = this.api.hap.uuid.generate('clearlight-' + device.did);
      matchedUuids.add(uuid);

      const existingHandler = this.handlers.get(uuid);
      if (existingHandler) {
        existingHandler.updateHost(device.ip);
        continue;
      }

      let accessory = this.cachedAccessories.get(uuid);
      if (!accessory) {
        const name = 'Sauna ' + device.did.slice(-4);
        this.log.info('Discovered new sauna: %s at %s (ID: %s)', name, device.ip, device.did);
        accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.did = device.did;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(uuid, accessory);
      } else {
        this.log.info('Reconnecting cached sauna at %s (ID: %s)', device.ip, device.did);
      }

      const handler = new SaunaAccessoryHandler(this.log, accessory, this.api, {
        did: device.did,
        minTemp: this.config.minTemp as number | undefined,
        maxTemp: this.config.maxTemp as number | undefined,
        onAuthenticated: (info) => this.writeDeviceState(info),
      });
      this.handlers.set(uuid, handler);
    }

    // Clean up stale cached accessories that were never matched to a handler.
    // This happens when a device was previously registered under a different UUID
    // (e.g. after a DID parsing fix changes the UUID). Without this, ghost accessories
    // accumulate in accessories.json and are restored as unresponsive devices on every restart.
    for (const [uuid, accessory] of this.cachedAccessories) {
      if (!this.handlers.has(uuid)) {
        this.log.info('Removing stale cached accessory: %s (UUID: %s)', accessory.displayName, uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.delete(uuid);
      }
    }
  }
}
