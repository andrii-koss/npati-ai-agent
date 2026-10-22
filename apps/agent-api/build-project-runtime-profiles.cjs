const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const profiles = require('./project-runtime-profiles.json');
const frameworkLocks = require('./project-framework-locks.json');
const root = '/opt/npati-project-toolchain';
const resolved = {};
for (const [name, profile] of Object.entries(profiles)) {
  const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true });
  if (profile.lockedFramework) {
    // The exact manifest + lockfile the project scaffold writes, so a new project matches byte-for-byte in dependency
    // terms and receives a project-owned copy instead of a registry download. `npm ci` verifies every integrity hash.
    const lock = frameworkLocks[profile.lockedFramework];
    if (!lock?.packages?.['']) throw Error(`No stored lock for ${profile.lockedFramework}`);
    const { dependencies = {}, devDependencies = {} } = lock.packages[''];
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: lock.name, version: lock.version, private: true, dependencies, devDependencies }));
    fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit' });
    fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    resolved[name] = { dependencies, devDependencies };
    continue;
  }
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: `npati-prepared-${name}`, version: '0.1.0', private: true, ...profile }));
  // Resolve/install once while building the image, including native optional packages.
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit' });
  resolved[name] = profile;
}
fs.writeFileSync(path.join(root, 'profiles.json'), JSON.stringify(resolved));
