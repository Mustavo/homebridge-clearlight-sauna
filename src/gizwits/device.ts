/**
 * TCP device connection and control for Clearlight sauna.
 * Handles authentication, heartbeat, state polling, and attribute control.
 *
 * Control flow:
 *   1. sendControl() - sends command, returns Promise resolving on 0x94 ACK (5s timeout)
 *   2. awaitStateCondition() - listens for next state event matching predicate (7s timeout)
 *   3. Public methods (setPower etc.) combine both + retry once on mismatch
 *   4. Callers receive a rejected Promise if the sauna doesn't confirm the change
 */

import * as net from 'net';
import { EventEmitter } from 'events';
import {
  TCP_PORT,
  Command,
  SaunaState,
  buildFrame,
  buildControlFrame,
  parseFrame,
  parseState,
  buildFlagControl,
  buildTempControl,
  buildSpectrumControl,
  buildMinuteControl,
  FLAG_POWER,
  FLAG_INTERNAL_LIGHT,
  FLAG_EXTERNAL_LIGHT,
  FLAG_CF,
} from './protocol';

export interface DeviceOptions {
  host: string;
  port?: number;
  pollingInterval?: number; // ms, default 10000
  log?: (msg: string, ...args: unknown[]) => void;
}

export class ClearlightDevice extends EventEmitter {
  private host: string;
  private port: number;
  private pollingInterval: number;
  private log: (msg: string, ...args: unknown[]) => void;

  private socket: net.Socket | null = null;
  private passcode: Buffer | null = null;
  private connected = false;
  private authenticated = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private receiveBuffer = Buffer.alloc(0);
  private destroyed = false;
  private sequenceNumber = 0;

  private _state: SaunaState | null = null;

  constructor(options: DeviceOptions) {
    super();
    this.host = options.host;
    this.port = options.port ?? TCP_PORT;
    this.pollingInterval = options.pollingInterval ?? 10000;
    this.log = options.log ?? (() => {});
  }

  get state(): SaunaState | null {
    return this._state;
  }

  get isConnected(): boolean {
    return this.connected && this.authenticated;
  }

  // --- Lifecycle ---

  async connect(): Promise<void> {
    if (this.destroyed) return;
    this.log('Connecting to sauna at %s:%d', this.host, this.port);

    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      let connectResolved = false;

      this.socket.on('connect', () => {
        this.connected = true;
        this.log('TCP connected');
        this.startHeartbeat();
        this.requestPasscode();
        connectResolved = true;
        resolve();
      });

      this.socket.on('data', (data) => this.onData(data));

      this.socket.on('error', (err) => {
        this.log('Socket error: %s', err.message);
        if (!connectResolved) {
          connectResolved = true;
          reject(err);
        }
        this.handleDisconnect();
      });

      this.socket.on('close', () => {
        this.log('Socket closed');
        this.handleDisconnect();
      });

      this.socket.connect(this.port, this.host);
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.stopTimers();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.authenticated = false;
  }

  // --- Data handling ---

  private onData(data: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    while (this.receiveBuffer.length > 0) {
      const result = parseFrame(this.receiveBuffer);
      if (!result) break;

      this.receiveBuffer = this.receiveBuffer.subarray(result.bytesConsumed);
      this.handleFrame(result.frame.command, result.frame.payload);
    }
  }

  private handleFrame(cmd: Command, payload: Buffer): void {
    switch (cmd) {
      case Command.PASSCODE_RESPONSE:
        this.passcode = Buffer.from(payload);
        this.log('Got passcode (%d bytes)', payload.length);
        this.login();
        break;

      case Command.LOGIN_RESPONSE:
        if (payload.length > 0 && payload[0] === 0x00) {
          this.authenticated = true;
          this.log('Authenticated');
          this.startPolling();
          this.requestState();
          this.emit('authenticated');
        } else {
          this.log('Login failed, status: 0x%s', payload[0]?.toString(16));
          this.emit('error', new Error('Login failed'));
        }
        break;

      case Command.HEARTBEAT_PONG:
        break;

      case Command.STATE_RESPONSE:
        this.handleStateResponse(payload);
        break;

      case Command.CONTROL_RESPONSE:
        this.log('Control ACK received');
        this.emit('controlAck');
        break;

      default:
        this.log('Unknown command: 0x%s', cmd.toString(16));
    }
  }

  private handleStateResponse(payload: Buffer): void {
    const state = parseState(payload);
    if (state) {
      const prev = this._state;
      this._state = state;
      this.emit('state', state, prev);
    } else {
      this.log('State parse failed (%d bytes)', payload.length);
    }
  }

  // --- Internal protocol ---

  private send(frame: Buffer): void {
    if (this.socket && this.connected) {
      this.socket.write(frame);
    }
  }

  private requestPasscode(): void {
    this.send(buildFrame(Command.PASSCODE_REQUEST));
  }

  private login(): void {
    if (!this.passcode) return;
    this.send(buildFrame(Command.LOGIN_REQUEST, this.passcode));
  }

  requestState(): void {
    const payload = Buffer.from([0x02]); // action: read all
    this.send(buildFrame(Command.STATE_REQUEST, payload));
  }

  /**
   * Send a control payload and return a Promise that resolves when the sauna ACKs (0x94).
   * Rejects if not authenticated, if ACK times out, or if the device disconnects.
   * After ACK, schedules a state refresh delayed to allow the sauna to process the command
   * (~2.5s; per CHANGELOG ACK arrives at 2-4s, state follows shortly after).
   */
  private sendControl(payload: Buffer, ackTimeoutMs = 5000): Promise<void> {
    if (!this.authenticated || !this.socket || this.destroyed) {
      return Promise.reject(new Error('Device not connected'));
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.off('controlAck', onAck);
        this.off('disconnected', onDisconnect);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Control ACK timeout after ' + ackTimeoutMs + 'ms'));
      }, ackTimeoutMs);

      const onAck = () => {
        clearTimeout(timer);
        cleanup();
        // Give the sauna time to action the command before polling state
        setTimeout(() => { if (!this.destroyed) this.requestState(); }, 2500);
        resolve();
      };

      const onDisconnect = () => {
        clearTimeout(timer);
        cleanup();
        reject(new Error('Device disconnected while waiting for ACK'));
      };

      this.once('controlAck', onAck);
      this.once('disconnected', onDisconnect);
      this.sequenceNumber++;
      this.send(buildControlFrame(this.sequenceNumber, payload));
    });
  }

  /**
   * Wait for a state event where predicate returns true.
   * Checks current state first (handles the case where state arrived before listener setup).
   * Resolves false if the device disconnects or timeout expires.
   */
  private awaitStateCondition(predicate: (s: SaunaState) => boolean, timeoutMs: number): Promise<boolean> {
    if (this._state && predicate(this._state)) return Promise.resolve(true);

    return new Promise((resolve) => {
      const cleanup = () => {
        this.off('state', onState);
        this.off('disconnected', onDisconnect);
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const onState = (state: SaunaState) => {
        if (predicate(state)) {
          clearTimeout(timer);
          cleanup();
          resolve(true);
        }
      };

      const onDisconnect = () => {
        clearTimeout(timer);
        cleanup();
        resolve(false);
      };

      this.on('state', onState);
      this.once('disconnected', onDisconnect);
    });
  }

  /**
   * Send a control command and verify the sauna state reflects the change.
   * Retries once if the first attempt is not confirmed within the state timeout.
   * Throws if still unconfirmed after retry.
   */
  private async sendControlAndVerify(
    payload: Buffer,
    predicate: (s: SaunaState) => boolean,
    description: string,
    retries = 1,
  ): Promise<void> {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      await this.sendControl(payload);
      const confirmed = await this.awaitStateCondition(predicate, 7000);
      if (confirmed) return;
      if (attempt <= retries) {
        this.log('Command "%s" not confirmed (attempt %d/%d), retrying', description, attempt, retries + 1);
      }
    }
    throw new Error('Sauna did not confirm: ' + description);
  }

  // --- Public control methods (all async, all verified) ---

  async setPower(on: boolean): Promise<void> {
    await this.sendControlAndVerify(
      buildFlagControl(FLAG_POWER, on),
      (s) => s.power === on,
      'power ' + (on ? 'on' : 'off'),
    );
  }

  async setTargetTemperature(tempF: number): Promise<void> {
    await this.sendControlAndVerify(
      buildTempControl(tempF),
      (s) => Math.abs(s.setTemp - tempF) <= 1,
      'setTemp ' + tempF + 'F',
    );
  }

  async setInternalLight(on: boolean): Promise<void> {
    await this.sendControlAndVerify(
      buildFlagControl(FLAG_INTERNAL_LIGHT, on),
      (s) => s.internalLight === on,
      'internalLight ' + (on ? 'on' : 'off'),
    );
  }

  async setExternalLight(on: boolean): Promise<void> {
    await this.sendControlAndVerify(
      buildFlagControl(FLAG_EXTERNAL_LIGHT, on),
      (s) => s.externalLight === on,
      'externalLight ' + (on ? 'on' : 'off'),
    );
  }

  async setCelsius(celsius: boolean): Promise<void> {
    await this.sendControlAndVerify(
      buildFlagControl(FLAG_CF, celsius),
      (s) => s.celsius === celsius,
      'celsius ' + celsius,
    );
  }

  async setTimer(minutes: number): Promise<void> {
    // Timer state verification is approximate (setMinute may be 0 if not in pre-time mode)
    await this.sendControl(buildMinuteControl(minutes));
    this.log('Timer set to %d minutes (state verification skipped for timer)', minutes);
  }

  /** Set LED brightness. LED appears read-only via protocol (controlled from physical panel).
   *  Best-effort: sends spectrum control. No state verification. */
  async setLed(brightness: number): Promise<void> {
    const b = Math.max(0, Math.min(255, Math.round(brightness)));
    const currentLeft = this._state?.left ?? 0;
    await this.sendControl(buildSpectrumControl(b, currentLeft));
    this.log('LED brightness command sent (%d/255) - state verification skipped (LED may be read-only)', b);
  }

  async setHeaterIntensity(left: number, right: number): Promise<void> {
    const r = Math.max(0, Math.min(255, Math.round(right)));
    const l = Math.max(0, Math.min(255, Math.round(left)));
    await this.sendControlAndVerify(
      buildSpectrumControl(r, l),
      (s) => Math.abs(s.right - r) <= 2 && Math.abs(s.left - l) <= 2,
      'heaterIntensity left=' + l + ' right=' + r,
    );
  }

  // --- Timers ---

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send(buildFrame(Command.HEARTBEAT_PING));
    }, 4000);
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.requestState();
    }, this.pollingInterval);
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private handleDisconnect(): void {
    this.stopTimers();
    this.connected = false;
    this.authenticated = false;
    this.passcode = null;
    this.receiveBuffer = Buffer.alloc(0);

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    if (!this.destroyed) {
      this.emit('disconnected');
      this.log('Scheduling reconnect in 10s');
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch(() => {
          this.log('Reconnect failed, will retry');
        });
      }, 10000);
    }
  }
}
