#!/usr/bin/env npx ts-node
/**
 * CLI tool for direct sauna control and protocol testing.
 * Usage: npx ts-node src/cli.ts <command> [args]
 *
 * Commands:
 *   discover                  Find sauna on the network
 *   status                    Show current sauna state
 *   power <on|off>            Toggle power
 *   temp <celsius>            Set target temperature
 *   led <0-100>               Set LED brightness (%)
 *   light <int|ext> <on|off>  Toggle internal/external light
 *   heater <left> <right>     Set heater intensity (0-255)
 *   timer <minutes>           Set session timer (0-60)
 *   monitor                   Live state monitoring (ctrl+c to stop)
 *   raw                       Dump raw binary frames for debugging
 */

import { ClearlightDevice } from './gizwits/device';
import { discoverSauna } from './gizwits/discovery';
import type { SaunaState } from './gizwits/protocol';
import * as fs from 'fs';
import * as path from 'path';

const ENV_FILE = path.join(__dirname, '..', '.env');
const USAGE = `
Usage: npx ts-node src/cli.ts <command> [args]

Commands:
  discover                  Find sauna on the network
  status                    Show current sauna state
  power <on|off>            Toggle power
  temp <celsius>            Set target temperature (Celsius)
  led <0-100>               Set LED brightness (%)
  light <int|ext> <on|off>  Toggle internal/external light
  heater <left> <right>     Set heater intensity (0-255)
  timer <minutes>           Set session timer (0-60)
  monitor                   Live state monitoring (ctrl+c to stop)

Set SAUNA_HOST env var or create .env with SAUNA_HOST=192.168.x.x
`.trim();

// --- Helpers ---

function loadHost(): string | null {
  if (process.env.SAUNA_HOST) return process.env.SAUNA_HOST;
  try {
    const env = fs.readFileSync(ENV_FILE, 'utf8');
    const match = env.match(/SAUNA_HOST=(.+)/);
    if (match) return match[1].trim();
  } catch { /* no .env */ }
  return null;
}

function saveHost(host: string): void {
  fs.writeFileSync(ENV_FILE, `SAUNA_HOST=${host}\n`);
}

function fToC(f: number): number {
  return Math.round(((f - 32) * 5) / 9);
}

function cToF(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

function formatState(s: SaunaState): string {
  const lines = [
    '',
    `  Power:          ${s.power ? 'ON' : 'OFF'}`,
    `  Current temp:   ${fToC(s.currentTemp)}C / ${s.currentTemp}F`,
    `  Target temp:    ${fToC(s.setTemp)}C / ${s.setTemp}F`,
    `  Timer:          ${s.setMinute} min`,
    `  Pre-heat:       ${s.preTimeEnabled ? `${pad(s.preTimeHour)}:${pad(s.preTimeMinute)}` : 'OFF'}`,
    `  Left heater:    ${s.left}/255`,
    `  Right heater:   ${s.right}/255`,
    `  LED:            ${s.led}/255 (${Math.round((s.led / 255) * 100)}%)`,
    `  Internal light: ${s.internalLight ? 'ON' : 'OFF'}`,
    `  External light: ${s.externalLight ? 'ON' : 'OFF'}`,
    `  Unit:           ${s.celsius ? 'Celsius' : 'Fahrenheit'}`,
    `  Serial:         ${s.serialNumber}`,
    '',
  ];
  return lines.join('\n');
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function timestamp(): string {
  return new Date().toLocaleTimeString('en-AU', { hour12: false });
}

// --- Connect helper ---

function connectDevice(host: string): Promise<ClearlightDevice> {
  return new Promise((resolve, reject) => {
    const device = new ClearlightDevice({
      host,
      pollingInterval: 5000,
      log: (msg, ...args) => {
        const formatted = args.reduce<string>((s, a) => s.replace(/%[sd]/, String(a)), msg);
        console.log(`  [debug] ${formatted}`);
      },
    });

    const timeout = setTimeout(() => {
      device.destroy();
      reject(new Error('Connection timed out after 10s'));
    }, 10000);

    device.on('authenticated', () => {
      clearTimeout(timeout);
      resolve(device);
    });

    device.on('error', (err: Error) => {
      clearTimeout(timeout);
      device.destroy();
      reject(err);
    });

    device.connect().catch((err) => {
      clearTimeout(timeout);
      device.destroy();
      reject(err);
    });
  });
}

/** Wait for first state response after connection */
function waitForState(device: ClearlightDevice, timeoutMs = 5000): Promise<SaunaState> {
  return new Promise((resolve, reject) => {
    if (device.state) { resolve(device.state); return; }
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for state')), timeoutMs);
    device.on('state', (state: SaunaState) => {
      clearTimeout(timeout);
      resolve(state);
    });
  });
}

/**
 * Wait for control ACK (0x94) then the next state update.
 * The device processes controls async: 0x94 ACK comes first, then 0x91 with new state.
 */
function waitForControlResult(device: ClearlightDevice, timeoutMs = 8000): Promise<SaunaState> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Timeout -- return current state even if unchanged
      if (device.state) resolve(device.state);
      else reject(new Error('Timed out waiting for control result'));
    }, timeoutMs);

    let gotAck = false;

    device.on('controlAck', () => {
      gotAck = true;
    });

    device.on('state', (state: SaunaState) => {
      if (gotAck) {
        clearTimeout(timeout);
        resolve(state);
      }
    });
  });
}

// --- Commands ---

async function cmdDiscover(): Promise<void> {
  console.log('Broadcasting UDP discovery...');
  const result = await discoverSauna(8000);
  if (!result) {
    console.log('No sauna found on the network.');
    console.log('Make sure the sauna is powered on and connected to WiFi.');
    console.log('If it is new, hold the power button for 7 seconds to enter pairing mode.');
    process.exit(1);
  }
  console.log(`Found sauna at ${result.ip} (device ID: ${result.did})`);
  saveHost(result.ip);
  console.log(`Saved to .env: SAUNA_HOST=${result.ip}`);
}

async function cmdStatus(host: string): Promise<void> {
  console.log(`Connecting to ${host}...`);
  const device = await connectDevice(host);
  console.log('Connected. Requesting state...');
  const state = await waitForState(device);
  console.log(formatState(state));
  device.destroy();
}

async function cmdPower(host: string, onOff: string): Promise<void> {
  if (onOff !== 'on' && onOff !== 'off') {
    console.log('Usage: power <on|off>');
    process.exit(1);
  }
  const device = await connectDevice(host);
  await waitForState(device);
  console.log(`Setting power ${onOff}...`);
  device.setPower(onOff === 'on');
  const s = await waitForControlResult(device);
  console.log(`Power is now ${s.power ? 'ON' : 'OFF'}`);
  device.destroy();
}

async function cmdTemp(host: string, tempStr: string): Promise<void> {
  const celsius = parseInt(tempStr, 10);
  if (isNaN(celsius) || celsius < 16 || celsius > 82) {
    console.log('Usage: temp <16-82> (Celsius)');
    process.exit(1);
  }
  const fahrenheit = cToF(celsius);
  const device = await connectDevice(host);
  await waitForState(device);
  console.log(`Setting target temperature to ${celsius}C (${fahrenheit}F)...`);
  device.setTargetTemperature(fahrenheit);
  const s = await waitForControlResult(device);
  console.log(`Target temp confirmed: ${fToC(s.setTemp)}C / ${s.setTemp}F`);
  device.destroy();
}

async function cmdLed(host: string, pctStr: string): Promise<void> {
  const pct = parseInt(pctStr, 10);
  if (isNaN(pct) || pct < 0 || pct > 100) {
    console.log('Usage: led <0-100> (percentage)');
    process.exit(1);
  }
  const raw = Math.round((pct / 100) * 255);
  const device = await connectDevice(host);
  await waitForState(device);
  console.log(`Setting LED to ${pct}% (${raw}/255)...`);
  device.setLed(raw);
  const s = await waitForControlResult(device);
  console.log(`LED confirmed: ${s.led}/255 (${Math.round((s.led / 255) * 100)}%)`);
  device.destroy();
}

async function cmdLight(host: string, which: string, onOff: string): Promise<void> {
  if ((which !== 'int' && which !== 'ext') || (onOff !== 'on' && onOff !== 'off')) {
    console.log('Usage: light <int|ext> <on|off>');
    process.exit(1);
  }
  const device = await connectDevice(host);
  await waitForState(device);
  const target = onOff === 'on';
  const label = which === 'int' ? 'internal' : 'external';
  console.log(`Setting ${label} light ${onOff}...`);
  if (which === 'int') device.setInternalLight(target);
  else device.setExternalLight(target);
  const s = await waitForControlResult(device);
  const actual = which === 'int' ? s.internalLight : s.externalLight;
  console.log(`${label} light is now ${actual ? 'ON' : 'OFF'}`);
  device.destroy();
}

async function cmdHeater(host: string, leftStr: string, rightStr: string): Promise<void> {
  const left = parseInt(leftStr, 10);
  const right = parseInt(rightStr, 10);
  if (isNaN(left) || isNaN(right) || left < 0 || left > 255 || right < 0 || right > 255) {
    console.log('Usage: heater <left 0-255> <right 0-255>');
    process.exit(1);
  }
  const device = await connectDevice(host);
  await waitForState(device);
  console.log(`Setting heater intensity: left=${left}, right=${right}...`);
  device.setHeaterIntensity(left, right);
  const s = await waitForControlResult(device);
  console.log(`Heaters confirmed: left=${s.left}/255, right=${s.right}/255`);
  device.destroy();
}

async function cmdTimer(host: string, minStr: string): Promise<void> {
  const minutes = parseInt(minStr, 10);
  if (isNaN(minutes) || minutes < 0 || minutes > 60) {
    console.log('Usage: timer <0-60> (minutes)');
    process.exit(1);
  }
  const device = await connectDevice(host);
  await waitForState(device);
  console.log(`Setting timer to ${minutes} minutes...`);
  device.setTimer(minutes);
  const s = await waitForControlResult(device);
  console.log(`Timer confirmed: ${s.setMinute} min`);
  device.destroy();
}

async function cmdMonitor(host: string): Promise<void> {
  console.log(`Connecting to ${host} for live monitoring...`);
  console.log('Press ctrl+c to stop.\n');
  const device = await connectDevice(host);

  device.on('state', (state: SaunaState, prev: SaunaState | null) => {
    if (!prev) {
      console.log(`[${timestamp()}] Initial state:`);
      console.log(formatState(state));
      return;
    }

    // Only print changes
    const changes: string[] = [];
    if (state.power !== prev.power) changes.push(`power: ${state.power ? 'ON' : 'OFF'}`);
    if (state.currentTemp !== prev.currentTemp) changes.push(`current: ${fToC(state.currentTemp)}C`);
    if (state.setTemp !== prev.setTemp) changes.push(`target: ${fToC(state.setTemp)}C`);
    if (state.led !== prev.led) changes.push(`led: ${Math.round((state.led / 255) * 100)}%`);
    if (state.internalLight !== prev.internalLight) changes.push(`int light: ${state.internalLight ? 'ON' : 'OFF'}`);
    if (state.externalLight !== prev.externalLight) changes.push(`ext light: ${state.externalLight ? 'ON' : 'OFF'}`);
    if (state.left !== prev.left) changes.push(`left heater: ${state.left}`);
    if (state.right !== prev.right) changes.push(`right heater: ${state.right}`);
    if (state.setMinute !== prev.setMinute) changes.push(`timer: ${state.setMinute}min`);

    if (changes.length > 0) {
      console.log(`[${timestamp()}] ${changes.join(' | ')}`);
    }
  });

  // Keep alive until ctrl+c
  process.on('SIGINT', () => {
    console.log('\nDisconnecting...');
    device.destroy();
    process.exit(0);
  });

  // Prevent exit
  await new Promise(() => {});
}

// --- Main ---

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    process.exit(0);
  }

  if (command === 'discover') {
    await cmdDiscover();
    return;
  }

  // All other commands need a host
  const host = loadHost();
  if (!host) {
    console.log('No sauna IP configured.');
    console.log('Run "discover" first, or set SAUNA_HOST=192.168.x.x in .env');
    process.exit(1);
  }

  switch (command) {
    case 'status':   await cmdStatus(host); break;
    case 'power':    await cmdPower(host, args[0]); break;
    case 'temp':     await cmdTemp(host, args[0]); break;
    case 'led':      await cmdLed(host, args[0]); break;
    case 'light':    await cmdLight(host, args[0], args[1]); break;
    case 'heater':   await cmdHeater(host, args[0], args[1]); break;
    case 'timer':    await cmdTimer(host, args[0]); break;
    case 'monitor':  await cmdMonitor(host); break;
    default:
      console.log(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
