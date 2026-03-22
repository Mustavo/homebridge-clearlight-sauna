/**
 * Gizwits GAgent LAN protocol constants and helpers.
 * Binary protocol over TCP port 12416 / UDP ports 12414-2415.
 *
 * Message frame: [0x00 0x00 0x00 0x03] [varint length] [0x00] [cmd hi] [cmd lo] [payload...]
 *
 * State and control formats reverse-engineered from spinrag/node-gizwits reference
 * and validated against Clearlight Sanctuary at 192.168.x.x.
 */

// --- Network ports ---
export const UDP_BROADCAST_PORT = 12414;
export const UDP_LISTEN_PORT = 2415;
export const TCP_PORT = 12416;

// --- Command codes ---
export enum Command {
  // Discovery (UDP)
  DISCOVER_REQUEST = 0x0003,
  DISCOVER_RESPONSE = 0x0004,

  // Authentication (TCP)
  PASSCODE_REQUEST = 0x0006,
  PASSCODE_RESPONSE = 0x0007,
  LOGIN_REQUEST = 0x0008,
  LOGIN_RESPONSE = 0x0009,

  // Heartbeat (TCP)
  HEARTBEAT_PING = 0x0015,
  HEARTBEAT_PONG = 0x0016,

  // Device state (TCP)
  STATE_REQUEST = 0x0090,
  STATE_RESPONSE = 0x0091,
  CONTROL_REQUEST = 0x0093,
  CONTROL_RESPONSE = 0x0094,
}

// --- Sauna attribute bit flags (in the flags byte) ---
export const FLAG_EXTERNAL_LIGHT = 0x01;
export const FLAG_INTERNAL_LIGHT = 0x02;
export const FLAG_PRE_TIME = 0x04;
export const FLAG_POWER = 0x08;
export const FLAG_CF = 0x10; // 0 = Fahrenheit, 1 = Celsius
export const FLAG_UVB = 0x20;
export const FLAG_N = 0x40;

// --- State byte order (after action byte, confirmed from reference implementation) ---
// Raw state example: 04 | 10 00 64 64 a0 08 00 00 00 00 4c 00
//                    act  fl ld rt lt st sh sm ph pm sn ct hp
// Byte order: flags, LED, RIGHT, LEFT, SET_TEMP, SET_HOUR, SET_MINUTE,
//             PRE_TIME_HOUR, PRE_TIME_MINUTE, SN, CURRENT_TEMP, heart_pulse

// --- Sauna state interface ---
export interface SaunaState {
  power: boolean;
  internalLight: boolean;
  externalLight: boolean;
  preTimeEnabled: boolean;
  celsius: boolean;
  uvb: boolean;
  led: number;           // 0-255 LED brightness
  right: number;         // 0-255 heater intensity
  left: number;          // 0-255 heater intensity
  setTemp: number;       // Fahrenheit
  setHour: number;
  setMinute: number;
  preTimeHour: number;
  preTimeMinute: number;
  serialNumber: number;
  currentTemp: number;   // Fahrenheit
  heartPulse: number;
}

// --- Frame builder ---

const FRAME_HEADER = Buffer.from([0x00, 0x00, 0x00, 0x03]);

export function buildFrame(cmd: Command, payload: Buffer = Buffer.alloc(0)): Buffer {
  // Length = 1 (flag byte 0x00) + 2 (command) + payload length
  const innerLength = 1 + 2 + payload.length;
  const lengthVarint = encodeVarint(innerLength);

  const frame = Buffer.alloc(FRAME_HEADER.length + lengthVarint.length + 1 + 2 + payload.length);
  let offset = 0;

  FRAME_HEADER.copy(frame, offset); offset += FRAME_HEADER.length;
  lengthVarint.copy(frame, offset); offset += lengthVarint.length;
  frame[offset++] = 0x00; // flag byte
  frame.writeUInt16BE(cmd, offset); offset += 2;
  if (payload.length > 0) {
    payload.copy(frame, offset);
  }

  return frame;
}

/**
 * Build a control frame with sequence number (required for 0x0093 commands).
 * Format: [header] [0x14] [0x00] [0x00 0x93] [seq 4 bytes] [payload 13 bytes]
 */
export function buildControlFrame(seqNum: number, payload: Buffer): Buffer {
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32BE(seqNum);

  // Inner length = 1 (flag) + 2 (cmd) + 4 (seq) + payload.length
  const innerLength = 1 + 2 + 4 + payload.length;
  const lengthVarint = encodeVarint(innerLength);

  const frame = Buffer.alloc(FRAME_HEADER.length + lengthVarint.length + 1 + 2 + 4 + payload.length);
  let offset = 0;

  FRAME_HEADER.copy(frame, offset); offset += FRAME_HEADER.length;
  lengthVarint.copy(frame, offset); offset += lengthVarint.length;
  frame[offset++] = 0x00; // flag byte
  frame.writeUInt16BE(Command.CONTROL_REQUEST, offset); offset += 2;
  seqBuf.copy(frame, offset); offset += 4;
  payload.copy(frame, offset);

  return frame;
}

// --- Frame parser ---

export interface ParsedFrame {
  command: Command;
  payload: Buffer;
}

/**
 * Parse a complete Gizwits frame from a buffer.
 * Returns the parsed frame and how many bytes were consumed, or null if incomplete.
 */
export function parseFrame(data: Buffer): { frame: ParsedFrame; bytesConsumed: number } | null {
  if (data.length < FRAME_HEADER.length + 1) return null;

  // Validate header
  if (data[0] !== 0x00 || data[1] !== 0x00 || data[2] !== 0x00 || data[3] !== 0x03) {
    return null;
  }

  let offset = FRAME_HEADER.length;
  const varintResult = decodeVarint(data, offset);
  if (!varintResult) return null;

  const { value: innerLength, bytesRead } = varintResult;
  offset += bytesRead;

  // Check we have the full frame
  if (data.length < offset + innerLength) return null;

  const flagByte = data[offset]; offset += 1;
  void flagByte; // unused but part of protocol

  const command = data.readUInt16BE(offset) as Command; offset += 2;
  const payloadLength = innerLength - 3; // subtract flag + command bytes
  const payload = data.subarray(offset, offset + payloadLength);

  return {
    frame: { command, payload: Buffer.from(payload) },
    bytesConsumed: offset + payloadLength,
  };
}

// --- State parser ---

export function parseState(payload: Buffer): SaunaState | null {
  // Payload: [action byte] [flags] [LED] [RIGHT] [LEFT] [SET_TEMP] [SET_HOUR]
  //          [SET_MINUTE] [PRE_TIME_HOUR] [PRE_TIME_MINUTE] [SN] [CURRENT_TEMP] [heart_pulse]
  if (payload.length < 7) return null; // action + flags + at least 5 data bytes

  let i = 0;
  i++; // skip action byte (0x04 for state report)

  const flags = payload[i++];

  return {
    power: !!(flags & FLAG_POWER),
    internalLight: !!(flags & FLAG_INTERNAL_LIGHT),
    externalLight: !!(flags & FLAG_EXTERNAL_LIGHT),
    preTimeEnabled: !!(flags & FLAG_PRE_TIME),
    celsius: !!(flags & FLAG_CF),
    uvb: !!(flags & FLAG_UVB),
    led: i < payload.length ? payload[i++] : 0,
    right: i < payload.length ? payload[i++] : 0,
    left: i < payload.length ? payload[i++] : 0,
    setTemp: i < payload.length ? payload[i++] : 0,
    setHour: i < payload.length ? payload[i++] : 0,
    setMinute: i < payload.length ? payload[i++] : 0,
    preTimeHour: i < payload.length ? payload[i++] : 0,
    preTimeMinute: i < payload.length ? payload[i++] : 0,
    serialNumber: i < payload.length ? payload[i++] : 0,
    currentTemp: i < payload.length ? payload[i++] : 0,
    heartPulse: i < payload.length ? payload[i++] : 0,
  };
}

// --- Control payload builders ---
// Each attribute has its own command format. Payload is always 13 bytes.
// [0] = 0x01 (action: write)
// [1] = attribute type selector
// [2-12] = attribute-specific values

/** Control attribute type selectors */
const CTRL_TYPE_FLAG = 0x00;
const CTRL_TYPE_SPECTRUM = 0x03;
const CTRL_TYPE_TEMP = 0x04;
const CTRL_TYPE_HOUR = 0x08;
const CTRL_TYPE_MINUTE = 0x10;
const CTRL_TYPE_PRE_HOUR = 0x20;
const CTRL_TYPE_PRE_MINUTE = 0x40;

function makeControlPayload(type: number): Buffer {
  const buf = Buffer.alloc(13);
  buf[0] = 0x01; // action: write
  buf[1] = type;
  return buf;
}

export function buildFlagControl(flagId: number, value: boolean): Buffer {
  const buf = makeControlPayload(CTRL_TYPE_FLAG);
  buf[2] = flagId;       // which flag
  buf[3] = value ? flagId : 0x00; // value: flag bit set or cleared
  return buf;
}

export function buildTempControl(tempF: number): Buffer {
  const buf = makeControlPayload(CTRL_TYPE_TEMP);
  buf[7] = Math.max(60, Math.min(180, Math.round(tempF)));
  return buf;
}

export function buildSpectrumControl(right: number, left: number): Buffer {
  const buf = makeControlPayload(CTRL_TYPE_SPECTRUM);
  buf[5] = Math.max(0, Math.min(255, Math.round(right)));
  buf[6] = Math.max(0, Math.min(255, Math.round(left)));
  return buf;
}

export function buildHourControl(hour: number): Buffer {
  const buf = makeControlPayload(CTRL_TYPE_HOUR);
  buf[8] = Math.max(0, Math.min(23, Math.round(hour)));
  return buf;
}

export function buildMinuteControl(minute: number): Buffer {
  const buf = makeControlPayload(CTRL_TYPE_MINUTE);
  buf[9] = Math.max(0, Math.min(60, Math.round(minute)));
  return buf;
}

export function buildPreHourControl(hour: number): Buffer {
  const buf = makeControlPayload(CTRL_TYPE_PRE_HOUR);
  buf[10] = Math.max(0, Math.min(23, Math.round(hour)));
  return buf;
}

export function buildPreMinuteControl(minute: number): Buffer {
  const buf = makeControlPayload(CTRL_TYPE_PRE_MINUTE);
  buf[11] = Math.max(0, Math.min(59, Math.round(minute)));
  return buf;
}

// --- Varint encoding (protobuf-style) ---

export function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

function decodeVarint(buf: Buffer, offset: number): { value: number; bytesRead: number } | null {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset + bytesRead < buf.length) {
    const byte = buf[offset + bytesRead];
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    if ((byte & 0x80) === 0) {
      return { value, bytesRead };
    }
    shift += 7;
    if (shift > 28) return null; // overflow protection
  }

  return null; // incomplete
}
