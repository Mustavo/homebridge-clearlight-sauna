import type { API } from 'homebridge';
import { ClearlightSaunaAccessory } from './sauna-accessory';

export default (api: API) => {
  api.registerAccessory('homebridge-clearlight-sauna', 'ClearlightSauna', ClearlightSaunaAccessory);
};
