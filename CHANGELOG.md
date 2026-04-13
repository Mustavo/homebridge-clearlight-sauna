# Changelog

All notable changes to `homebridge-clearlight-sauna` are documented here.

## [2.1.1] - 2026-04-13

### Changed
- README updated for v2.1.0 features (MAC-based config, at-temp sensor, custom UI status panel).

---

## [2.1.0] - 2026-04-13

### Added
- **MAC address-based device identity** - Pin a sauna by hardware MAC address. Survives DHCP lease rotation. Configured via `mac` field in device config.
- **Gizwits device ID support** - Alternative stable identifier (`did` field) if MAC is not available.
- **Auto-discovery with MAC enrichment** - On each discovery cycle, ARP is used to resolve the MAC address of every responding sauna. Pinned devices are matched by MAC/DID, not IP.
- **Configurable per-device settings** - Each configured sauna now supports: display name, min/max temperature range, default temperature, internal light name, external light name.
- **At Temperature occupancy sensor** - Optional occupancy sensor (enable via `atTempSensor: true`) that triggers when the sauna reaches its target temperature. Enable notifications on this sensor in the Home app to receive a native push notification when your sauna is ready.
- **Custom UI status panel** - Homebridge Config UI X shows a live status card for each sauna: name, MAC, IP address, and time since last contact.
- **Device state persistence** - Plugin writes `clearlightsauna-state.json` to the Homebridge storage directory on every successful connection, used by the custom UI.
- **`discover` CLI command shows MAC** - `npm run sauna -- discover` now outputs MAC address alongside IP and Device ID.

### Changed
- **Control hardening** - All HomeKit set handlers are now async with full ACK + state verification. HomeKit shows "No Response" if the sauna is unreachable, and shows an error if the command is sent but not confirmed within 7 seconds.
- **`requireDevice()` guard** - If the sauna is not connected, HomeKit immediately shows "No Response" instead of silently succeeding.
- **Retry logic** - Each control command automatically retries once before failing.
- **State refresh timing** - State refresh fires 2500ms post-ACK (was 500ms pre-ACK) to allow the sauna time to process commands before re-reading state.
- **`host` field deprecated** - Static IP address config still works but is deprecated. Use `mac` instead.
- **Auto-discovery** - New saunas found on the network are always registered, even when a `devices` list is configured. Existing pinned devices are matched by MAC/DID and updated with their current IP.

### Fixed
- Silent control failures: `onSet` returning `void` caused HomeKit to show false success when commands were never delivered.
- Null guard no-ops: `device?.method()` would silently skip controls if the device connection was not yet established.
- Stale state reads: poll was firing before the sauna processed the command, returning the pre-change state.

---

## [2.0.2] - 2026-03-23

### Added
- Initial Homebridge dynamic platform plugin.
- Exposes sauna as HomeKit HeaterCooler (power, target temperature, current temperature) plus two Switch services (internal light, external light). Controllable via Apple Home app and Siri.
- CLI tool (`npm run sauna -- <command>`) for direct LAN testing and control. Commands: `discover`, `status`, `power`, `temp`, `led`, `light`, `heater`, `timer`, `monitor`.
- UDP broadcast discovery - finds sauna on local network automatically, no IP configuration required.
- Gizwits GAgent binary protocol (TCP 12416 / UDP 12414) reverse-engineered and validated against hardware.

### Protocol details (for contributors)
- Passcode: 12 bytes (negotiated per device)
- State byte order: flags, LED, RIGHT, LEFT, SET_TEMP, SET_HOUR, SET_MINUTE, PRE_TIME_HOUR, PRE_TIME_MINUTE, SN, CURRENT_TEMP, heart_pulse
- Control format: 13-byte payload, one attribute per command, 4-byte sequence number in frame
- 0x94 ACK arrives ~2-4s after command; state update follows

---
