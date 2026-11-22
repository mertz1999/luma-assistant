const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { repo, desktop, stage } = require('./paths.cjs');
const account = 'reza.tz780210@gmail.com';
const developerDir = '/Applications/Xcode.app/Contents/Developer';
const npmCache = process.env.LUMA_DESKTOP_NPM_CACHE || path.join(require('node:os').tmpdir(), 'luma-desktop-npm-cache');

function run(command, args, cwd = repo, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, npm_config_cache: npmCache, DEVELOPER_DIR: developerDir, ...extraEnv }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Build Luma Desktop on macOS.');
  // Never let automatic certificate discovery select another account on this Mac.
  const identities = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const identity = identities.stdout.split('\n').find(line => line.includes(`Apple Development: ${account} (`));
  if (!identity) throw new Error(`The Apple Development identity for ${account} is missing. No other account will be used.`);
  if (!fs.existsSync(path.join(developerDir, 'usr/bin/xcodebuild'))) throw new Error('Xcode.app is required at /Applications/Xcode.app.');
  for (const workspace of ['@luma/shared', '@luma/server', '@luma/web']) run('npm', ['run', 'build', '-w', workspace]);
  fs.mkdirSync(stage, { recursive: true });
  const installedMarker = path.join(stage, '.installed-package');
  const previousPackage = fs.existsSync(installedMarker) ? fs.readFileSync(installedMarker, 'utf8') : '';
  for (const directory of ['desktop', 'server', 'web', 'packages/shared/dist']) fs.rmSync(path.join(stage, directory), { recursive: true, force: true });
  const copy = (source, destination) => fs.cpSync(path.join(repo, source), path.join(stage, destination), { recursive: true });
  copy('apps/desktop/src', 'desktop');
  copy('apps/server/dist', 'server');
  copy('apps/web/dist', 'web');
  copy('packages/shared/dist', 'packages/shared/dist');
  copy('packages/shared/package.json', 'packages/shared/package.json');
  copy('plan.md', 'plan.md');
  const serverPackage = JSON.parse(fs.readFileSync(path.join(repo, 'apps/server/package.json'), 'utf8'));
  const desktopPackage = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  const release = path.join(desktop, 'release', desktopPackage.version);
  const stagedPackage = JSON.stringify({
    name: 'luma-desktop', version: desktopPackage.version, private: true,
    description: 'Luma cloud and local coding sessions for macOS', author: { name: 'Reza Tanakizadeh', email: account },
    main: 'desktop/main.cjs', type: 'module', dependencies: { ...serverPackage.dependencies, ...desktopPackage.lumaRuntimeDependencies, '@luma/shared': 'file:packages/shared' },
    devDependencies: { electron: desktopPackage.devDependencies.electron },
  }, null, 2);
  fs.writeFileSync(path.join(stage, 'package.json'), stagedPackage);
  if (previousPackage !== stagedPackage || !fs.existsSync(path.join(stage, 'node_modules'))) {
    run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
    // A failed installation must be retried even though package.json was written.
    fs.writeFileSync(installedMarker, stagedPackage);
  }
  const nativeMarker = path.join(stage, '.native-build');
  const nativeIdentity = `${desktopPackage.devDependencies.electron}:${process.arch}:${stagedPackage}`;
  const nativeReady = fs.existsSync(nativeMarker) && fs.readFileSync(nativeMarker, 'utf8') === nativeIdentity;
  const { build, Platform, Arch } = require('electron-builder');
  await build({
    projectDir: stage,
    targets: Platform.MAC.createTarget(process.argv.includes('--package') ? ['dir', 'dmg'] : ['dir'], process.arch === 'arm64' ? Arch.arm64 : Arch.x64),
    publish: 'never',
    config: {
      appId: 'com.rezatanakizadeh.luma', productName: 'Luma Desktop', electronVersion: desktopPackage.devDependencies.electron,
      directories: { output: release },
      asar: false, npmRebuild: !nativeReady, forceCodeSigning: true,
      files: ['desktop/**', 'server/**', 'web/**', 'plan.md', 'packages/shared/**', 'package.json', 'node_modules/**'],
      mac: { category: 'public.app-category.developer-tools', icon: path.join(repo, 'apps/web/public/icons/icon-512.png'), identity: account, type: 'development', hardenedRuntime: true, notarize: false, timestamp: 'none',
        entitlements: path.join(desktop, 'build/entitlements.mac.plist'), entitlementsInherit: path.join(desktop, 'build/entitlements.mac.plist'),
        extendInfo: { NSMicrophoneUsageDescription: 'Luma records your voice when you use dictation.' },
      },
      dmg: { title: 'Luma Desktop', sign: false },
    },
  });
  const application = path.join(release, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Luma Desktop.app');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
  const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', application], { encoding: 'utf8' });
  if (signature.status !== 0 || !signature.stderr.includes(`Authority=Apple Development: ${account}`) || !signature.stderr.includes('TeamIdentifier=R4HM99JM59')) {
    throw new Error('Signing verification failed: the app must use Reza’s development identity and team R4HM99JM59.');
  }
  fs.writeFileSync(nativeMarker, nativeIdentity);
  console.log(`Built with ${account}. This is a local development build; public distribution requires Developer ID signing and notarization.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
