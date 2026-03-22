# homebridge-clearlight-sauna

Homebridge plugin to control a Clearlight/Jacuzzi infrared sauna via Apple HomeKit and Siri.

Communicates directly with the sauna over your local network using the Gizwits GAgent binary protocol. No cloud, no internet required.

## What You Get in HomeKit

| Control | HomeKit Service | Siri Example |
|---------|----------------|--------------|
| Power + temperature | HeaterCooler | "Hey Siri, turn on the sauna" / "Set the sauna to 60 degrees" |
| Internal light | Switch | "Turn on the internal light" |
| External light | Switch | "Turn on the external light" |

LED/chromotherapy is read-only (controlled from the sauna's physical panel).

## CLI Tool

Direct sauna control for testing and daily use:

```bash
npm run sauna -- discover              # find sauna on network, save IP
npm run sauna -- status                # full state dump
npm run sauna -- power on              # turn on
npm run sauna -- power off             # turn off
npm run sauna -- temp 55               # set target to 55C
npm run sauna -- light int on          # internal light on
npm run sauna -- light ext off         # external light off
npm run sauna -- heater 200 200        # left/right heater intensity
npm run sauna -- timer 45              # 45 min session
npm run sauna -- monitor               # live state stream
```

## Prerequisites

- [Homebridge](https://homebridge.io) installed and running
- Clearlight/Jacuzzi infrared sauna on the same LAN
- Sauna has a static IP (set this in your router's DHCP reservations)

## Install

```bash
cd /path/to/this/plugin
npm install
npm run build
npm link

# Then in your Homebridge directory:
npm link homebridge-clearlight-sauna
```

## Configuration

Add to your Homebridge `config.json` accessories array:

```json
{
  "accessory": "ClearlightSauna",
  "name": "Sauna",
  "host": "192.168.1.XXX",
  "minTemp": 16,
  "maxTemp": 66,
  "pollingInterval": 10
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| accessory | Yes | - | Must be `"ClearlightSauna"` |
| name | Yes | `"Sauna"` | Name shown in HomeKit |
| host | Yes | - | Sauna's static IP address |
| minTemp | No | `16` | Min target temp in Celsius |
| maxTemp | No | `66` | Max target temp in Celsius (66C = 150F) |
| pollingInterval | No | `10` | Seconds between state polls |

## Protocol

Local LAN only. The sauna's WiFi module runs the Gizwits GAgent firmware:
- TCP binary on port 12416 (all control/state)
- UDP broadcast on port 12414 (discovery)
- Auth: passcode request/login, then heartbeat every 4s
- Controls processed async: ACK (0x94) arrives ~2-4s after command

Full protocol details in [src/gizwits/protocol.ts](src/gizwits/protocol.ts).

## Development

```bash
npm install
npm run build     # compile TypeScript
npm run watch     # compile on change
npm run sauna     # CLI tool
```
