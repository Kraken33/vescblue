const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo Config Plugin that automatically configures iOS Podfile on `npx expo prebuild` / `npx expo run:ios`
 * to:
 *  1. Set SWIFT_VERSION = 5.0 and SWIFT_STRICT_CONCURRENCY = minimal for MultiplatformBleAdapter compatibility
 *  2. Run `node ../scripts/patch-ble.js` inside `post_install` whenever `pod install` completes
 */
module.exports = function withBleFixes(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) {
        return cfg;
      }

      let podfile = fs.readFileSync(podfilePath, 'utf8');
      const hookMarker = '# [withBleFixes] Automated BLE Pod patches';

      if (!podfile.includes(hookMarker)) {
        const snippet = `
    ${hookMarker}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        config.build_settings['SWIFT_VERSION'] = '5.0'
        config.build_settings['SWIFT_STRICT_CONCURRENCY'] = 'minimal'
      end
    end
    system("node", File.join(__dir__, "..", "scripts", "patch-ble.js"))
`;
        // Insert right before the final `end` of `post_install do |installer|`
        podfile = podfile.replace(
          /(\s+react_native_post_install\([\s\S]*?\)\n)/,
          `$1${snippet}`
        );
        fs.writeFileSync(podfilePath, podfile, 'utf8');
      }

      return cfg;
    },
  ]);
};
