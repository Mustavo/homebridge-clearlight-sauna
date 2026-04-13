const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const fs = require('fs');
const path = require('path');

class SaunaUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/device-status', this.getDeviceStatus.bind(this));
    this.ready();
  }

  async getDeviceStatus() {
    const statePath = path.join(this.homebridgeStoragePath, 'clearlightsauna-state.json');
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      return {};
    }
  }
}

new SaunaUiServer();
