/**
 * Clearlight Sauna dynamic platform plugin.
 * Discovers saunas on the LAN and registers each as a cached accessory.
 */

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
  host: string;
  name?: string;
  maxTemp?: number;
  minTemp?: number;
}

export { PLUGIN_NAME, PLATFORM_NAME };

export class SaunaPlatform implements DynamicPlatformPlugin {
  private readonly cachedAccessories: Map<string, PlatformAccessory> = new Map();
  private readonly handlers: Map<string, SaunaAccessoryHandler> = new Map();
  private readonly discoveryTimeout: number;
  private readonly discoveryInterval: number;
  private readonly devices: DeviceConfig[];
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly log: Logging,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    this.discoveryTimeout = (config.discoveryTimeout ?? 5) * 1000;
    this.discoveryInterval = (config.discoveryInterval ?? 60) * 1000;
    this.devices = (config.devices as DeviceConfig[]) ?? [];

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

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring cached accessory: %s', accessory.displayName);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private setupPinnedDevices(): void {
    for (const deviceConfig of this.devices) {
      const uuid = this.api.hap.uuid.generate('clearlight-' + deviceConfig.host);
      const name = deviceConfig.name ?? 'Sauna';

      let accessory = this.cachedAccessories.get(uuid);
      if (!accessory) {
        this.log.info('Adding pinned sauna: %s (%s)', name, deviceConfig.host);
        accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.host = deviceConfig.host;
        accessory.context.pinned = true;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(uuid, accessory);
      }

      if (!this.handlers.has(uuid)) {
        const handler = new SaunaAccessoryHandler(this.log, accessory, this.api, {
          host: deviceConfig.host,
          minTemp: deviceConfig.minTemp,
          maxTemp: deviceConfig.maxTemp,
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

    for (const device of discovered) {
      const uuid = this.api.hap.uuid.generate('clearlight-' + device.did);

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
        host: device.ip,
        minTemp: this.config.minTemp as number | undefined,
        maxTemp: this.config.maxTemp as number | undefined,
      });
      this.handlers.set(uuid, handler);
    }
  }
}
