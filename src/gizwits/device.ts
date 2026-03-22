/**
 * TCP device connection and control for Clearlight sauna.
 * Handles authentication, heartbeat, state polling, and attribute control.
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
        this.log('Control ACK');
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

  // --- Protocol commands ---

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

  private sendControlPayload(payload: Buffer): void {
    if (!this.authenticated) return;
    this.sequenceNumber++;
    const frame = buildControlFrame(this.sequenceNumber, payload);
    this.send(frame);
    // Request state update after a short delay to confirm
    setTimeout(() => this.requestState(), 500);
  }

  // --- Public control methods ---

  setPower(on: boolean): void {
    this.sendControlPayload(buildFlagControl(FLAG_POWER, on));
  }

  setTargetTemperature(tempF: number): void {
    this.sendControlPayload(buildTempControl(tempF));
  }

  /** Set LED brightness. The LED shares the spectrum control (right=LED, left=current left). */
  setLed(brightness: number): void {
    // LED is controlled via the spectrum command with the LED value in the right position
    // Based on the state format: LED is its own field, but control might use spectrum
    // Try flag-style first; if that doesn't work we'll use spectrum
    // Actually looking at the reference, there's no explicit LED control -- it appears
    // to be controlled via spectrum. Let's use spectrum: right=LED, left=currentLeft
    const currentLeft = this._state?.left ?? 0;
    this.sendControlPayload(buildSpectrumControl(
      Math.max(0, Math.min(255, Math.round(brightness))),
      currentLeft,
    ));
  }

  setInternalLight(on: boolean): void {
    this.sendControlPayload(buildFlagControl(FLAG_INTERNAL_LIGHT, on));
  }

  setExternalLight(on: boolean): void {
    this.sendControlPayload(buildFlagControl(FLAG_EXTERNAL_LIGHT, on));
  }

  setTimer(minutes: number): void {
    this.sendControlPayload(buildMinuteControl(minutes));
  }

  setCelsius(celsius: boolean): void {
    this.sendControlPayload(buildFlagControl(FLAG_CF, celsius));
  }

  setHeaterIntensity(left: number, right: number): void {
    this.sendControlPayload(buildSpectrumControl(
      Math.max(0, Math.min(255, Math.round(right))),
      Math.max(0, Math.min(255, Math.round(left))),
    ));
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
