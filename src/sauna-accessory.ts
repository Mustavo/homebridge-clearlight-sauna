/**
 * Configures HomeKit services on a PlatformAccessory for a Clearlight sauna.
 *
 * Exposes:
 * - HeaterCooler service: power on/off, target temp, current temp
 * - Switch: internal light
 * - Switch: external light
 *
 * All onSet handlers are async and return rejected Promises (HapStatusError) when the sauna
 * does not confirm the command, surfacing failures to HomeKit rather than silently no-oping.
 */

import type {
  API,
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

// HapStatusError is exported as type-only in some homebridge builds; access at runtime via api.hap
// SERVICE_COMMUNICATION_FAILURE = -70402
const SERVICE_COMM_FAILURE = -70402;
import { ClearlightDevice } from './gizwits/device';
import { discoverSauna, discoverByMac, discoverByDid } from './gizwits/discovery';
import type { SaunaState } from './gizwits/protocol';

export interface SaunaAccessoryOptions {
  /** Preferred: hardware MAC address (e.g. "aa:bb:cc:dd:ee:ff"). Survives DHCP lease rotation. */
  mac?: string;
  /** Alternative stable ID: Gizwits device ID from the discover command output. */
  did?: string;
  /** Deprecated: static IP. Use mac or did instead. Breaks if DHCP lease changes. */
  host?: string;
  minTemp?: number;
  maxTemp?: number;
  defaultTemp?: number;
  pollingInterval?: number;
  internalLightName?: string;
  externalLightName?: string;
  atTempSensor?: boolean;
  onAuthenticated?: (info: { mac: string | null; did: string | null; ip: string; name: string }) => void;
}

export class SaunaAccessoryHandler {
  private device: ClearlightDevice | null = null;
  private readonly heaterService: Service;
  private readonly internalLightService: Service;
  private readonly externalLightService: Service;

  private readonly minTemp: number;
  private readonly maxTemp: number;
  private readonly defaultTemp: number | null;
  private readonly pollingInterval: number;
  private readonly internalLightName: string;
  private readonly externalLightName: string;
  private readonly atTempSensorService: Service | null;
  private readonly onAuthenticated: SaunaAccessoryOptions['onAuthenticated'];

  // Stable hardware identifiers - at least one should be set for reliable reconnection
  private readonly mac: string | null;
  private readonly did: string | null;

  // Cached IP from last successful connect - used as a hint only, never trusted across reconnects
  private cachedIp: string | null;

  private connecting = false;
  private destroyed = false;

  constructor(
    private readonly log: Logging,
    private readonly accessory: PlatformAccessory,
    private readonly api: API,
    options: SaunaAccessoryOptions,
  ) {
    const hap = api.hap;

    this.mac  = options.mac  ? options.mac.toLowerCase().replace(/-/g, ':') : null;
    this.did  = options.did  ?? null;
    this.cachedIp = options.host ?? null; // legacy fallback
    this.minTemp  = options.minTemp  ?? 16;
    this.maxTemp  = options.maxTemp  ?? 66;
    this.defaultTemp   = options.defaultTemp ?? null;
    this.pollingInterval = (options.pollingInterval ?? 10) * 1000;
    this.internalLightName = options.internalLightName || 'Internal Light';
    this.externalLightName = options.externalLightName || 'External Light';
    this.onAuthenticated = options.onAuthenticated;

    if (!this.mac && !this.did && options.host) {
      this.log.warn(
        'Sauna configured with a static IP (%s). If the DHCP lease changes the plugin will lose the device. ' +
        'Run "npm run sauna -- discover" and use the MAC address instead.',
        options.host,
      );
    }

    this.accessory.getService(hap.Service.AccessoryInformation)!
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Clearlight / Jacuzzi')
      .setCharacteristic(hap.Characteristic.Model, 'Sanctuary Infrared Sauna')
      .setCharacteristic(hap.Characteristic.SerialNumber, this.mac ?? this.did ?? 'auto-discovered');

    this.heaterService = this.accessory.getService(hap.Service.HeaterCooler)
      ?? this.accessory.addService(hap.Service.HeaterCooler, this.accessory.displayName);

    this.heaterService.getCharacteristic(hap.Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet((value) => this.setActive(value));

    this.heaterService.getCharacteristic(hap.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.getCurrentState());

    this.heaterService.getCharacteristic(hap.Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [hap.Characteristic.TargetHeaterCoolerState.HEAT] })
      .onGet(() => hap.Characteristic.TargetHeaterCoolerState.HEAT)
      .onSet(() => {});

    this.heaterService.getCharacteristic(hap.Characteristic.CurrentTemperature)
      .setProps({ minValue: -10, maxValue: 100, minStep: 1 })
      .onGet(() => this.getCurrentTemp());

    this.heaterService.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: this.minTemp, maxValue: this.maxTemp, minStep: 1 })
      .onGet(() => this.getTargetTemp())
      .onSet((value) => this.setTargetTemp(value));

    // Use subtype ('internal-light') as the stable service identifier; display name is configurable
    this.internalLightService = this.accessory.getServiceById(hap.Service.Switch, 'internal-light')
      ?? this.accessory.addService(hap.Service.Switch, this.internalLightName, 'internal-light');
    this.internalLightService.updateCharacteristic(hap.Characteristic.Name, this.internalLightName);

    this.internalLightService.getCharacteristic(hap.Characteristic.On)
      .onGet(() => this.device?.state?.internalLight ?? false)
      .onSet((value) => this.setInternalLight(value));

    this.externalLightService = this.accessory.getServiceById(hap.Service.Switch, 'external-light')
      ?? this.accessory.addService(hap.Service.Switch, this.externalLightName, 'external-light');
    this.externalLightService.updateCharacteristic(hap.Characteristic.Name, this.externalLightName);

    this.externalLightService.getCharacteristic(hap.Characteristic.On)
      .onGet(() => this.device?.state?.externalLight ?? false)
      .onSet((value) => this.setExternalLight(value));

    if (options.atTempSensor) {
      this.atTempSensorService = this.accessory.getServiceById(hap.Service.OccupancySensor, 'at-temp')
        ?? this.accessory.addService(hap.Service.OccupancySensor, 'At Temperature', 'at-temp');
      this.atTempSensorService.getCharacteristic(hap.Characteristic.OccupancyDetected)
        .onGet(() => this.getAtTemp());
    } else {
      // Remove the service if it was previously enabled and is now disabled
      const existing = this.accessory.getServiceById(hap.Service.OccupancySensor, 'at-temp');
      if (existing) this.accessory.removeService(existing);
      this.atTempSensorService = null;
    }

    this.connectToSauna();
  }

  /** Called by the platform when discovery finds a new IP for this device. */
  updateHost(newHost: string): void {
    if (this.cachedIp === newHost) return;
    this.log.info('Sauna IP updated by discovery: %s -> %s', this.cachedIp, newHost);
    this.cachedIp = newHost;
    if (this.device) {
      this.device.destroy();
      this.device = null;
      this.connecting = false;
      this.connectToSauna();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.device?.destroy();
    this.device = null;
  }

  private async connectToSauna(): Promise<void> {
    if (this.connecting || this.destroyed) return;
    this.connecting = true;

    try {
      const host = await this.resolveHost();
      if (!host) {
        this.log.warn('Sauna not found on network, retrying in 30s');
        setTimeout(() => { this.connecting = false; this.connectToSauna(); }, 30000);
        return;
      }

      this.cachedIp = host;

      if (!this.device) {
        this.device = new ClearlightDevice({
          host,
          pollingInterval: this.pollingInterval,
          log: (msg, ...args) => this.log.debug(msg, ...args),
        });

        this.device.on('state', (state: SaunaState) => this.updateCharacteristics(state));
        this.device.on('authenticated', () => {
          this.log.info('Sauna connected at %s', host);
          this.accessory.getService(this.api.hap.Service.AccessoryInformation)!
            .updateCharacteristic(this.api.hap.Characteristic.SerialNumber, this.mac ?? this.did ?? host);
          this.onAuthenticated?.({
            mac: this.mac,
            did: this.did,
            ip: host,
            name: this.accessory.displayName,
          });
        });
        this.device.on('disconnected', () => {
          this.log.warn('Sauna disconnected, re-discovering...');
          this.device?.destroy();
          this.device = null;
          this.cachedIp = null; // discard cached IP - always re-discover on reconnect
          this.connecting = false;
          if (!this.destroyed) {
            setTimeout(() => this.connectToSauna(), 10000);
          }
        });
        this.device.on('error', (err: Error) => this.log.error('Sauna error: %s', err.message));
      }

      await this.device.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('Connection failed: %s, retrying in 15s', msg);
      this.device?.destroy();
      this.device = null;
      this.cachedIp = null; // discard cached IP on failure
      if (!this.destroyed) {
        setTimeout(() => { this.connecting = false; this.connectToSauna(); }, 15000);
      }
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Resolve the current IP for this sauna.
   *
   * Priority:
   * 1. MAC configured → UDP discover all → ARP each → match MAC (fully IP-independent)
   * 2. DID configured → UDP discover all → match device ID
   * 3. Legacy host → attempt cached IP directly (with deprecation warning already issued)
   * 4. Zero-config → first device found on network
   *
   * The cached IP is NEVER used here for reconnects - always rediscover.
   * On initial connect the platform may have already set cachedIp via updateHost(),
   * but even then a stable ID config will rediscover to confirm the IP is current.
   */
  private async resolveHost(): Promise<string | null> {
    if (this.mac) {
      this.log.debug('Discovering sauna by MAC %s...', this.mac);
      const result = await discoverByMac(this.mac, 8000);
      if (result) {
        this.log.info('Found sauna (MAC %s) at %s', this.mac, result.ip);
        return result.ip;
      }
      this.log.warn('No sauna found matching MAC %s', this.mac);
      return null;
    }

    if (this.did) {
      this.log.debug('Discovering sauna by device ID %s...', this.did);
      const result = await discoverByDid(this.did, 8000);
      if (result) {
        this.log.info('Found sauna (DID %s) at %s', this.did, result.ip);
        return result.ip;
      }
      this.log.warn('No sauna found matching device ID %s', this.did);
      return null;
    }

    // Legacy: static IP configured
    if (this.cachedIp) {
      this.log.debug('Using configured IP: %s', this.cachedIp);
      return this.cachedIp;
    }

    // Zero-config: first sauna found
    this.log.info('No identifier configured, discovering first sauna on network...');
    const result = await discoverSauna(8000);
    if (result) {
      this.log.info('Found sauna at %s (DID: %s)', result.ip, result.did);
      return result.ip;
    }
    return null;
  }

  // --- Getters ---

  private getActive(): CharacteristicValue {
    const state = this.device?.state;
    return state?.power
      ? this.api.hap.Characteristic.Active.ACTIVE
      : this.api.hap.Characteristic.Active.INACTIVE;
  }

  private getCurrentState(): CharacteristicValue {
    const hap = this.api.hap;
    const state = this.device?.state;
    if (!state || !state.power) {
      return hap.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }
    if (state.currentTemp < state.setTemp) {
      return hap.Characteristic.CurrentHeaterCoolerState.HEATING;
    }
    return hap.Characteristic.CurrentHeaterCoolerState.IDLE;
  }

  private getAtTemp(): CharacteristicValue {
    const hap = this.api.hap;
    const state = this.device?.state;
    const atTemp = !!(state?.power && state.currentTemp >= state.setTemp && state.setTemp > 0);
    return atTemp
      ? hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  private getCurrentTemp(): CharacteristicValue {
    const state = this.device?.state;
    if (!state || state.currentTemp === 0) return 20;
    return this.fToC(state.currentTemp);
  }

  private getTargetTemp(): CharacteristicValue {
    const state = this.device?.state;
    if (!state) return this.defaultTemp ?? this.minTemp;
    return Math.max(this.minTemp, Math.min(this.maxTemp, this.fToC(state.setTemp)));
  }

  // --- Setters (async - HomeKit sees failure if sauna doesn't confirm) ---

  private requireDevice(): ClearlightDevice {
    if (!this.device?.isConnected) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throw new (this.api.hap as any).HapStatusError(SERVICE_COMM_FAILURE);
    }
    return this.device;
  }

  private hapCommError(): never {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    throw new (this.api.hap as any).HapStatusError(SERVICE_COMM_FAILURE);
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const device = this.requireDevice();
    try {
      await device.setPower(value === this.api.hap.Characteristic.Active.ACTIVE);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('setPower failed: %s', msg);
      this.hapCommError();
    }
  }

  private async setTargetTemp(value: CharacteristicValue): Promise<void> {
    const device = this.requireDevice();
    const celsius = value as number;
    const fahrenheit = Math.round((celsius * 9) / 5 + 32);
    try {
      await device.setTargetTemperature(fahrenheit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('setTargetTemperature failed: %s', msg);
      this.hapCommError();
    }
  }

  private async setInternalLight(value: CharacteristicValue): Promise<void> {
    const device = this.requireDevice();
    try {
      await device.setInternalLight(value as boolean);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('setInternalLight failed: %s', msg);
      this.hapCommError();
    }
  }

  private async setExternalLight(value: CharacteristicValue): Promise<void> {
    const device = this.requireDevice();
    try {
      await device.setExternalLight(value as boolean);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('setExternalLight failed: %s', msg);
      this.hapCommError();
    }
  }

  // --- Characteristic push updates ---

  private updateCharacteristics(state: SaunaState): void {
    const hap = this.api.hap;

    this.heaterService.updateCharacteristic(
      hap.Characteristic.Active,
      state.power ? hap.Characteristic.Active.ACTIVE : hap.Characteristic.Active.INACTIVE,
    );

    const currentTempC = state.currentTemp === 0 ? 20 : this.fToC(state.currentTemp);
    this.heaterService.updateCharacteristic(hap.Characteristic.CurrentTemperature, currentTempC);

    const targetTempC = Math.max(this.minTemp, Math.min(this.maxTemp, this.fToC(state.setTemp)));
    this.heaterService.updateCharacteristic(hap.Characteristic.HeatingThresholdTemperature, targetTempC);

    if (state.power) {
      const heatingState = state.currentTemp < state.setTemp
        ? hap.Characteristic.CurrentHeaterCoolerState.HEATING
        : hap.Characteristic.CurrentHeaterCoolerState.IDLE;
      this.heaterService.updateCharacteristic(hap.Characteristic.CurrentHeaterCoolerState, heatingState);
    } else {
      this.heaterService.updateCharacteristic(
        hap.Characteristic.CurrentHeaterCoolerState,
        hap.Characteristic.CurrentHeaterCoolerState.INACTIVE,
      );
    }

    this.internalLightService.updateCharacteristic(hap.Characteristic.On, state.internalLight);
    this.externalLightService.updateCharacteristic(hap.Characteristic.On, state.externalLight);

    if (this.atTempSensorService) {
      const atTemp = !!(state.power && state.currentTemp >= state.setTemp && state.setTemp > 0);
      this.atTempSensorService.updateCharacteristic(
        hap.Characteristic.OccupancyDetected,
        atTemp
          ? hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
      );
    }
  }

  private fToC(tempF: number): number {
    return Math.round(((tempF - 32) * 5) / 9);
  }
}
