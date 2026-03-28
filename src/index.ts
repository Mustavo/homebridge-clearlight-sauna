import type { API } from 'homebridge';
import { SaunaPlatform, PLATFORM_NAME, PLUGIN_NAME } from './platform';

export default (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SaunaPlatform);
};
