# Homebridge Clearlight Sauna Changelog

Structured change log for this project.
Each entry captures what changed, why, and the decision source.

---

## 2026-03-23 | Protocol Validated and Plugin Built

### Feature
- **Homebridge plugin** -- Exposes sauna as HomeKit HeaterCooler (power, target temp, current temp) + two Switch services (internal light, external light). Controllable via Apple Home app and Siri.
- **CLI tool** -- `npm run sauna -- <command>` for direct testing and control. Commands: discover, status, power, temp, led, light, heater, timer, monitor.
- **UDP discovery** -- finds sauna on LAN automatically, saves IP to .env.

### Protocol
- **Gizwits GAgent binary protocol** reverse-engineered and validated against device at 192.168.1.73
- **Passcode**: 12 bytes (docs said 10), ASCII `JRIVOMFGBK`
- **State byte order** (confirmed from reference + live testing): flags, LED, RIGHT, LEFT, SET_TEMP, SET_HOUR, SET_MINUTE, PRE_TIME_HOUR, PRE_TIME_MINUTE, SN, CURRENT_TEMP, heart_pulse
- **Control format**: 13-byte payload with type selector byte (0x00=flag, 0x03=spectrum, 0x04=temp, etc.), one attribute per command, requires 4-byte sequence number in frame
- **Timing**: device processes controls async, 0x94 ACK arrives after ~2-4s, state update follows

### Validated Controls
- Power on/off (flag 0x08) -- confirmed working
- Internal light on/off (flag 0x02) -- confirmed working
- External light (flag 0x01) -- protocol ready, untested on hardware
- Target temperature (type 0x04) -- confirmed working (set 55C/131F, verified in state)
- Timer (type 0x10) -- protocol ready
- Heater intensity / spectrum (type 0x03) -- ACK'd but only applies when powered on
- LED brightness -- read-only in protocol, controlled from physical panel only

---
