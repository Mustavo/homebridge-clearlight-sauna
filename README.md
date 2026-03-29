<p align="center">
  <img src="images/icon_100.png" alt="Clearlight Sauna icon" width="100">
</p>

# homebridge-clearlight-sauna

[![npm](https://img.shields.io/npm/v/homebridge-clearlight-sauna)](https://www.npmjs.com/package/homebridge-clearlight-sauna)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-clearlight-sauna)](https://www.npmjs.com/package/homebridge-clearlight-sauna)
[![Homebridge](https://img.shields.io/badge/homebridge-%3E%3D1.6.0-blueviolet)](https://homebridge.io)

Homebridge plugin to control a Clearlight/Jacuzzi infrared sauna via Apple HomeKit and Siri.

Communicates directly with the sauna over your local network using the Gizwits GAgent binary protocol. No cloud, no internet required.

<p align="center">
  <img src="images/SaunaControls.png" alt="Sauna in Apple Home app" width="300">
</p>

## Features

- Power on/off and target temperature via Siri or the Home app
- Internal and external light control
- Auto-discovers your sauna on the local network (UDP broadcast)
- Configurable via the Homebridge UI (Settings tab)
- Standalone CLI for direct sauna control and diagnostics
- Zero dependencies beyond Homebridge

## What You Get in HomeKit

| Control | HomeKit Service | Siri Example |
|---------|----------------|--------------|
| Power + temperature | HeaterCooler | "Hey Siri, turn on the sauna" / "Set the sauna to 60 degrees" |
| Internal light | Switch | "Turn on the internal light" |
| External light | Switch | "Turn on the external light" |

LED/chromotherapy is read-only (controlled from the sauna's physical panel).

## Compatibility

Tested with the Clearlight Sanctuary range. Should work with any Clearlight or Jacuzzi infrared sauna that has the WiFi module (Gizwits GAgent firmware on port 12416). If you've confirmed it working on another model, open an issue and let us know.

## Install

### Via Homebridge UI (recommended)

Search for `clearlight` in the Homebridge UI plugin tab and install.

### Via command line

```bash
npm install -g homebridge-clearlight-sauna
```

## Configuration

Saunas are auto-discovered on your local network. No configuration is required for most users -- just install the plugin and your sauna will appear in HomeKit.

For advanced setups, configure via the Homebridge UI Settings tab, or add to your `config.json` platforms array:

```json
{
  "platform": "ClearlightSauna",
  "name": "Clearlight Sauna"
}
```

To pin a sauna by IP (useful for multiple saunas or networks without broadcast):

```json
{
  "platform": "ClearlightSauna",
  "name": "Clearlight Sauna",
  "devices": [
    { "host": "192.168.1.100", "name": "Gym Sauna" },
    { "host": "192.168.1.101", "name": "Pool Sauna" }
  ]
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| platform | Yes | - | Must be `"ClearlightSauna"` |
| name | Yes | `"Clearlight Sauna"` | Platform name |
| discoveryTimeout | No | `5` | Seconds to listen for saunas per scan |
| discoveryInterval | No | `60` | Seconds between discovery scans |
| minTemp | No | `16` | Default min target temp in Celsius |
| maxTemp | No | `66` | Default max target temp in Celsius (66C = 150F) |
| devices | No | `[]` | Array of pinned saunas (see below) |

**Pinned device fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| host | Yes | - | Sauna's IP address |
| name | No | `"Sauna"` | Name shown in HomeKit |
| minTemp | No | Platform default | Override min temp for this sauna |
| maxTemp | No | Platform default | Override max temp for this sauna |

## CLI Tool

A standalone CLI is included for direct sauna control and diagnostics:

```bash
npx homebridge-clearlight-sauna discover        # find sauna on network
npx homebridge-clearlight-sauna status           # full state dump
npx homebridge-clearlight-sauna power on         # turn on
npx homebridge-clearlight-sauna power off        # turn off
npx homebridge-clearlight-sauna temp 55          # set target to 55C
npx homebridge-clearlight-sauna light int on     # internal light on
npx homebridge-clearlight-sauna light ext off    # external light off
npx homebridge-clearlight-sauna heater 200 200   # left/right heater intensity
npx homebridge-clearlight-sauna timer 45         # 45 min session
npx homebridge-clearlight-sauna monitor          # live state stream
```

## Protocol

Local LAN only. The sauna's WiFi module runs the Gizwits GAgent firmware:
- TCP binary on port 12416 (all control/state)
- UDP broadcast on port 12414 (discovery)
- Auth: passcode request/login, then heartbeat every 4s
- Controls processed async: ACK (0x94) arrives ~2-4s after command

Full protocol details in [src/gizwits/protocol.ts](src/gizwits/protocol.ts).

## Development

```bash
git clone https://github.com/Mustavo/homebridge-clearlight-sauna.git
cd homebridge-clearlight-sauna
npm install
npm run build     # compile TypeScript
npm run watch     # compile on change
npm run sauna     # CLI tool (from source)
```

## Licence

ISC
