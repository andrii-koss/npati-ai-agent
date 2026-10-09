const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const profiles = require('./project-runtime-profiles.json');
const root = '/opt/npati-project-toolchain';
for (const [name, dependencies] of Object.entries(profiles)) {
  const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: `npati-prepared-${name}`, version: '0.1.0', private: true, ...dependencies }));
  // Resolve/install once while building the image, including native optional packages.
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit' });
}
fs.writeFileSync(path.join(root, 'profiles.json'), JSON.stringify(profiles));
