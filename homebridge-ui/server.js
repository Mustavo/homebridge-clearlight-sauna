const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const fs = require('fs');
const path = require('path');

class SaunaUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/discovered-devices', this.getDiscoveredDevices.bind(this));
    this.ready();
  }

  async getDiscoveredDevices() {
    const statePath = path.join(this.homebridgeStoragePath, 'clearlightsauna-state.json');
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return Object.values(state);
    } catch {
      return [];
    }
  }
}

new SaunaUiServer();
