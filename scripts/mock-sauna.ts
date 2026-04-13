#!/usr/bin/env npx ts-node
/**
 * Mock Gizwits sauna server for local testing.
 *
 * Speaks the full Gizwits LAN binary protocol so ClearlightDevice (and the CLI)
 * can connect to localhost instead of real hardware.
 *
 * Usage:
 *   npx ts-node scripts/mock-sauna.ts [--port 19416] [--mode normal|no-ack|stale|slow-ack|disconnect]
 *
 * Modes:
 *   normal      Full protocol: ACK controls, update state (default)
 *   no-ack      Receive control but never send ACK -> tests ACK timeout
 *   stale       ACK control but don't update state -> tests retry + failure
 *   slow-ack    ACK after 4s delay -> tests timing margin
 *   disconnect  Close socket when control received -> tests reconnect
 */

import * as net from 'net';
import {
  Command,
  buildFrame,
  parseFrame,
  FLAG_POWER,
  FLAG_INTERNAL_LIGHT,
  FLAG_EXTERNAL_LIGHT,
  FLAG_CF,
} from '../src/gizwits/protocol';

const CTRL_TYPE_FLAG     = 0x00;
const CTRL_TYPE_SPECTRUM = 0x03;
const CTRL_TYPE_TEMP     = 0x04;
const CTRL_TYPE_MINUTE   = 0x10;

// --- Mock device state ---

interface MockState {
  power: boolean;
  internalLight: boolean;
  externalLight: boolean;
  celsius: boolean;
  led: number;
  right: number;
  left: number;
  setTemp: number;       // Fahrenheit
  setHour: number;
  setMinute: number;
  preTimeHour: number;
  preTimeMinute: number;
  serialNumber: number;
  currentTemp: number;   // Fahrenheit
  heartPulse: number;
}

const defaultState: MockState = {
  power: false,
  internalLight: false,
  externalLight: false,
  celsius: false,
  led: 0,
  right: 128,
  left: 128,
  setTemp: 140,       // ~60C
  setHour: 0,
  setMinute: 30,
  preTimeHour: 0,
  preTimeMinute: 0,
  serialNumber: 1,
  currentTemp: 75,    // ~24C ambient
  heartPulse: 0,
};

function buildStatePayload(s: MockState): Buffer {
  let flags = 0;
  if (s.power)         flags |= FLAG_POWER;
  if (s.internalLight) flags |= FLAG_INTERNAL_LIGHT;
  if (s.externalLight) flags |= FLAG_EXTERNAL_LIGHT;
  if (s.celsius)       flags |= FLAG_CF;

  const buf = Buffer.alloc(13);
  let i = 0;
  buf[i++] = 0x04;              // action: state report
  buf[i++] = flags;
  buf[i++] = s.led;
  buf[i++] = s.right;
  buf[i++] = s.left;
  buf[i++] = s.setTemp;
  buf[i++] = s.setHour;
  buf[i++] = s.setMinute;
  buf[i++] = s.preTimeHour;
  buf[i++] = s.preTimeMinute;
  buf[i++] = s.serialNumber;
  buf[i++] = s.currentTemp;
  buf[i++] = s.heartPulse;
  return buf;
}

function applyControl(state: MockState, payload: Buffer): void {
  // payload[0] = 0x01 (write action), [1] = type, [2..] = values
  if (payload.length < 2) return;
  const type = payload[1];

  if (type === CTRL_TYPE_FLAG) {
    const flagId = payload[2];
    const on = payload[3] !== 0;
    if (flagId === FLAG_POWER)          state.power = on;
    if (flagId === FLAG_INTERNAL_LIGHT) state.internalLight = on;
    if (flagId === FLAG_EXTERNAL_LIGHT) state.externalLight = on;
    if (flagId === FLAG_CF)             state.celsius = on;
  } else if (type === CTRL_TYPE_TEMP) {
    state.setTemp = payload[7] ?? state.setTemp;
  } else if (type === CTRL_TYPE_SPECTRUM) {
    state.right = payload[5] ?? state.right;
    state.left  = payload[6] ?? state.left;
  } else if (type === CTRL_TYPE_MINUTE) {
    state.setMinute = payload[9] ?? state.setMinute;
  }
}

// --- CLI args ---

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? parseInt(args[portArg + 1], 10) : 19416;
const modeArg = args.indexOf('--mode');
const MODE = (modeArg >= 0 ? args[modeArg + 1] : 'normal') as
  'normal' | 'no-ack' | 'stale' | 'slow-ack' | 'disconnect';

console.log(`[mock-sauna] Starting in mode="${MODE}" on port ${PORT}`);

// --- Per-connection handler ---

function handleConnection(socket: net.Socket): void {
  const addr = socket.remoteAddress + ':' + socket.remotePort;
  console.log(`[mock-sauna] Client connected: ${addr}`);

  const state: MockState = { ...defaultState };
  let buf = Buffer.alloc(0);

  const send = (frame: Buffer) => socket.write(frame);

  const sendState = () => {
    const payload = buildStatePayload(state);
    send(buildFrame(Command.STATE_RESPONSE, payload));
    console.log(`[mock-sauna] → STATE power=${state.power} temp=${state.setTemp}F currentTemp=${state.currentTemp}F intLight=${state.internalLight}`);
  };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    while (buf.length > 0) {
      const result = parseFrame(buf);
      if (!result) break;
      buf = buf.subarray(result.bytesConsumed);

      const { command, payload } = result.frame;
      console.log(`[mock-sauna] ← CMD 0x${command.toString(16).padStart(4, '0')} (${payload.length} bytes)`);

      switch (command) {
        case Command.PASSCODE_REQUEST: {
          // Respond with 12-byte passcode
          const passcode = Buffer.from('MockPasscode1!');
          send(buildFrame(Command.PASSCODE_RESPONSE, passcode));
          console.log('[mock-sauna] → PASSCODE_RESPONSE');
          break;
        }

        case Command.LOGIN_REQUEST: {
          // Always accept login
          const loginOk = Buffer.from([0x00]);
          send(buildFrame(Command.LOGIN_RESPONSE, loginOk));
          console.log('[mock-sauna] → LOGIN_RESPONSE OK');
          break;
        }

        case Command.HEARTBEAT_PING: {
          send(buildFrame(Command.HEARTBEAT_PONG));
          break;
        }

        case Command.STATE_REQUEST: {
          sendState();
          break;
        }

        case Command.CONTROL_REQUEST: {
          // payload: [4-byte seqNum] [13-byte control data]
          const controlData = payload.subarray(4);
          console.log(`[mock-sauna] ← CONTROL type=0x${controlData[1]?.toString(16)} data=${controlData.toString('hex')}`);

          if (MODE === 'disconnect') {
            console.log('[mock-sauna] Mode=disconnect: closing socket');
            socket.destroy();
            return;
          }

          if (MODE === 'no-ack') {
            console.log('[mock-sauna] Mode=no-ack: suppressing ACK');
            return;
          }

          if (MODE === 'stale') {
            console.log('[mock-sauna] Mode=stale: ACKing but NOT updating state');
            send(buildFrame(Command.CONTROL_RESPONSE));
            return;
          }

          const sendAckAndUpdate = () => {
            applyControl(state, controlData);
            send(buildFrame(Command.CONTROL_RESPONSE));
            console.log('[mock-sauna] → CONTROL_RESPONSE (ACK)');
            // Device will poll state shortly after - respond to that naturally
          };

          if (MODE === 'slow-ack') {
            console.log('[mock-sauna] Mode=slow-ack: delaying ACK by 3.5s');
            setTimeout(sendAckAndUpdate, 3500);
          } else {
            sendAckAndUpdate();
          }
          break;
        }

        default:
          console.log(`[mock-sauna] Unknown command: 0x${command.toString(16)}`);
      }
    }
  });

  socket.on('error', (err) => console.log(`[mock-sauna] Socket error: ${err.message}`));
  socket.on('close', () => console.log(`[mock-sauna] Client disconnected: ${addr}`));
}

// --- Server ---

const server = net.createServer(handleConnection);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-sauna] Listening on 127.0.0.1:${PORT}`);
  console.log('[mock-sauna] Ctrl+C to stop');
});

server.on('error', (err) => {
  console.error('[mock-sauna] Server error:', err.message);
  process.exit(1);
});
