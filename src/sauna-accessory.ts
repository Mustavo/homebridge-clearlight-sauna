/**
 * Homebridge accessory for Clearlight/Jacuzzi infrared sauna.
 *
 * Exposes:
 * - HeaterCooler service: power on/off, target temp, current temp
 * - Switch: internal light
 * - Switch: external light
 *
 * If no host is configured, uses UDP discovery to find the sauna on the LAN.
 * Re-discovers automatically if the connection drops (handles DHCP changes).
 *
 * LED/chromotherapy is read-only in the protocol (physical panel only).
 */

import type {
  API,
  AccessoryConfig,
  AccessoryPlugin,
  CharacteristicValue,
  Logging,
  Service,
} from 'homebridge';
import { ClearlightDevice } from './gizwits/device';
import { discoverSauna } from './gizwits/discovery';
import type { SaunaState } from './gizwits/protocol';

export class ClearlightSaunaAccessory implements AccessoryPlugin {
  private device: ClearlightDevice | null = null;
  private readonly informationService: Service;
  private readonly heaterService: Service;
  private readonly internalLightService: Service;
  private readonly externalLightService: Service;

  private readonly minTemp: number;
  private readonly maxTemp: number;
  private readonly pollingInterval: number;
  private discoveredHost: string | null = null;
  private connecting = false;

  constructor(
    private readonly log: Logging,
    private readonly config: AccessoryConfig,
    private readonly api: API,
  ) {
    const hap = api.hap;

    this.minTemp = config.minTemp ?? 16;
    this.maxTemp = config.maxTemp ?? 66;
    this.pollingInterval = (config.pollingInterval ?? 10) * 1000;

    // --- Information service ---
    this.informationService = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Clearlight / Jacuzzi')
      .setCharacteristic(hap.Characteristic.Model, 'Sanctuary Infrared Sauna')
      .setCharacteristic(hap.Characteristic.SerialNumber, 'auto-discovered');

    // --- HeaterCooler service (main thermostat control) ---
    this.heaterService = new hap.Service.HeaterCooler(config.name ?? 'Sauna');

    this.heaterService.getCharacteristic(hap.Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet((value) => this.setActive(value));

    this.heaterService.getCharacteristic(hap.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.getCurrentState());

    this.heaterService.getCharacteristic(hap.Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [hap.Characteristic.TargetHeaterCoolerState.HEAT] })
      .onGet(() => hap.Characteristic.TargetHeaterCoolerState.HEAT)
      .onSet(() => {}); // always heat mode

    this.heaterService.getCharacteristic(hap.Characteristic.CurrentTemperature)
      .setProps({ minValue: -10, maxValue: 100, minStep: 1 })
      .onGet(() => this.getCurrentTemp());

    this.heaterService.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: this.minTemp, maxValue: this.maxTemp, minStep: 1 })
      .onGet(() => this.getTargetTemp())
      .onSet((value) => this.setTargetTemp(value));

    // --- Internal light switch ---
    this.internalLightService = new hap.Service.Switch('Internal Light', 'internal-light');

    this.internalLightService.getCharacteristic(hap.Characteristic.On)
      .onGet(() => this.device?.state?.internalLight ?? false)
      .onSet((value) => this.device?.setInternalLight(value as boolean));

    // --- External light switch ---
    this.externalLightService = new hap.Service.Switch('External Light', 'external-light');

    this.externalLightService.getCharacteristic(hap.Characteristic.On)
      .onGet(() => this.device?.state?.externalLight ?? false)
      .onSet((value) => this.device?.setExternalLight(value as boolean));

    // --- Start connection (discover if needed) ---
    this.connectToSauna();
  }

  getServices(): Service[] {
    return [
      this.informationService,
      this.heaterService,
      this.internalLightService,
      this.externalLightService,
    ];
  }

  // --- Discovery and connection ---

  private async connectToSauna(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;

    try {
      const host = await this.resolveHost();
      if (!host) {
        this.log.warn('Sauna not found on network, retrying in 30s');
        setTimeout(() => { this.connecting = false; this.connectToSauna(); }, 30000);
        return;
      }

      // Tear down old device if IP changed
      if (this.device && this.discoveredHost !== host) {
        this.log.info('Sauna IP changed from %s to %s', this.discoveredHost, host);
        this.device.destroy();
        this.device = null;
      }

      this.discoveredHost = host;

      if (!this.device) {
        this.device = new ClearlightDevice({
          host,
          pollingInterval: this.pollingInterval,
          log: (msg, ...args) => this.log.debug(msg, ...args),
        });

        this.device.on('state', (state: SaunaState) => this.updateCharacteristics(state));
        this.device.on('authenticated', () => {
          this.log.info('Sauna connected at %s', host);
          // Update serial number with actual IP
          this.informationService.updateCharacteristic(
            this.api.hap.Characteristic.SerialNumber, host,
          );
        });
        this.device.on('disconnected', () => {
          this.log.warn('Sauna disconnected, will re-discover');
          // Re-discover on disconnect (IP may have changed)
          this.device?.destroy();
          this.device = null;
          this.connecting = false;
          setTimeout(() => this.connectToSauna(), 10000);
        });
        this.device.on('error', (err: Error) => this.log.error('Sauna error: %s', err.message));
      }

      await this.device.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('Connection failed: %s, retrying in 15s', msg);
      this.device?.destroy();
      this.device = null;
      setTimeout(() => { this.connecting = false; this.connectToSauna(); }, 15000);
    } finally {
      this.connecting = false;
    }
  }

  private async resolveHost(): Promise<string | null> {
    // Use configured host if provided
    if (this.config.host) {
      this.log.debug('Using configured host: %s', this.config.host);
      return this.config.host;
    }

    // Otherwise discover via UDP broadcast
    this.log.info('No host configured, discovering sauna on network...');
    const result = await discoverSauna(8000);
    if (result) {
      this.log.info('Discovered sauna at %s (ID: %s)', result.ip, result.did);
      return result.ip;
    }
    return null;
  }

  // --- HeaterCooler handlers ---

  private getActive(): CharacteristicValue {
    const state = this.device?.state;
    return state?.power
      ? this.api.hap.Characteristic.Active.ACTIVE
      : this.api.hap.Characteristic.Active.INACTIVE;
  }

  private setActive(value: CharacteristicValue): void {
    this.device?.setPower(value === this.api.hap.Characteristic.Active.ACTIVE);
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

  private getCurrentTemp(): CharacteristicValue {
    const state = this.device?.state;
    if (!state || state.currentTemp === 0) return 20;
    return this.fToC(state.currentTemp);
  }

  private getTargetTemp(): CharacteristicValue {
    const state = this.device?.state;
    if (!state) return this.minTemp;
    return Math.max(this.minTemp, Math.min(this.maxTemp, this.fToC(state.setTemp)));
  }

  private setTargetTemp(value: CharacteristicValue): void {
    const celsius = value as number;
    const fahrenheit = Math.round((celsius * 9) / 5 + 32);
    this.device?.setTargetTemperature(fahrenheit);
  }

  // --- Temperature conversion ---

  private fToC(tempF: number): number {
    return Math.round(((tempF - 32) * 5) / 9);
  }

  // --- Push state updates to HomeKit ---

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
  }
}
