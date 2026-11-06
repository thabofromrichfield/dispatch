const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'android', 'field-app');
const bridge = path.join(root, 'android', 'native-bridge.js');
const assets = path.join(root, 'android', 'app', 'src', 'main', 'assets');

// app/src/main/assets is a build output: `scripts/sync-android-assets.sh` (run by Gradle preBuild)
// copies the field web app there. Without this guard an edit to android/field-app can sit in the
// repository forever without ever reaching the APK.
test('shipped Android assets are byte-identical to the field app sources', () => {
  const files = fs.readdirSync(source).filter(name => fs.statSync(path.join(source, name)).isFile());
  assert.ok(files.length > 0, 'android/field-app has no source files');

  for (const name of files) {
    const copy = path.join(assets, name);
    assert.ok(fs.existsSync(copy), `${name} is missing from app/src/main/assets — run scripts/sync-android-assets.sh`);
    assert.deepEqual(fs.readFileSync(copy), fs.readFileSync(path.join(source, name)),
      `${name} in app/src/main/assets is stale — run scripts/sync-android-assets.sh`);
  }

  const bridgeCopy = path.join(assets, 'native-bridge.js');
  assert.ok(fs.existsSync(bridgeCopy), 'native-bridge.js is missing from app/src/main/assets');
  assert.deepEqual(fs.readFileSync(bridgeCopy), fs.readFileSync(bridge), 'native-bridge.js is stale');
});
