const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fields = ['dependencies', 'devDependencies', 'optionalDependencies'];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function dependencySet(manifest) { return Object.fromEntries(fields.map(field => [field, manifest[field] || {}])); }
function lockGraph(lock) {
  const result = structuredClone(lock);
  delete result.name; delete result.version;
  if (result.packages?.['']) { delete result.packages[''].name; delete result.packages[''].version; delete result.packages[''].license; }
  return result;
}
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function prepareWorkspace(workspace, toolchain, mode, copyModules = (source, target) => fs.cp(source, target, { recursive: true, verbatimSymlinks: true })) {
  const manifest = await json(path.join(workspace, 'package.json'));
  // Preserve npm lifecycle, workspace, override, peer and engine semantics.
  if (['workspaces', 'overrides', 'resolutions', 'peerDependencies', 'bundledDependencies', 'bundleDependencies', 'engines', 'os', 'cpu', 'packageManager', 'config'].some(key => manifest[key]) ||
      ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare'].some(key => manifest.scripts?.[key])) return null;
  const profiles = await json(path.join(toolchain, 'profiles.json'));
  const selected = Object.entries(profiles).find(([, profile]) => same(dependencySet(manifest), dependencySet(profile)));
  if (!selected) return null;
  const [name] = selected, source = path.join(toolchain, name);
  const preparedLock = await json(path.join(source, 'package-lock.json'));
  let existingLock;
  try { existingLock = await json(path.join(workspace, 'package-lock.json')); }
  catch (error) { if (error.code !== 'ENOENT') return null; }
  if (mode === 'ci' && !existingLock || existingLock && !same(lockGraph(existingLock), lockGraph(preparedLock))) return null;
  // Every project gets owned, writable copies. Never link writable shared modules.
  await fs.rm(path.join(workspace, 'node_modules'), { recursive: true, force: true });
  await copyModules(path.join(source, 'node_modules'), path.join(workspace, 'node_modules'));
  if (!existingLock) {
    preparedLock.name = manifest.name; preparedLock.version = manifest.version;
    preparedLock.packages[''].name = manifest.name; preparedLock.packages[''].version = manifest.version;
    await fs.writeFile(path.join(workspace, 'package-lock.json'), JSON.stringify(preparedLock, null, 2) + '\n');
  }
  return name;
}
async function seedWorkspace(workspace, toolchain, copyModules) {
  const manifest = await json(path.join(workspace, 'package.json'));
  try { await fs.access(path.join(workspace, 'node_modules')); return null; } catch { /* nothing installed yet */ }
  const wanted = Object.assign({}, manifest.dependencies, manifest.devDependencies);
  const profiles = await json(path.join(toolchain, 'profiles.json'));
  let best = null, bestShared = 0;
  for (const [name, profile] of Object.entries(profiles)) {
    const shared = Object.keys(Object.assign({}, profile.dependencies, profile.devDependencies)).filter(key => key in wanted).length;
    if (shared > bestShared) { best = name; bestShared = shared; }
  }
  if (!best) return null;
  await copyModules(path.join(toolchain, best, 'node_modules'), path.join(workspace, 'node_modules'));
  return best;
}
module.exports = { prepareWorkspace, seedWorkspace, dependencySet, lockGraph };
if (require.main === module) (async () => {
  const mode = process.argv[2]; if (!['install', 'ci'].includes(mode)) throw Error('Unsupported dependency preparation command');
  let profile = null;
  const copy = (source, target) => {
    const copied = spawnSync('cp', ['-R', '--preserve=mode,timestamps', '--no-preserve=ownership', '--reflink=auto', source, target], { encoding: 'utf8' });
    if (copied.error) throw copied.error;
    if (copied.status !== 0) throw Error(`Prepared dependency copy failed: ${copied.stderr.slice(0, 500)}`);
  };
  try { profile = await prepareWorkspace(process.cwd(), '/opt/npati-project-toolchain', mode, copy); }
  catch (error) {
    // A failed copy must fail explicitly; do not conceal permission/isolation errors.
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  }
  if (profile) { console.log(`Prepared dependencies: ${profile} (project-owned copy, no registry download)`); return; }
  // `npm ci` deletes node_modules first, so only `npm install` can use a seed.
  if (mode === 'install') await seedWorkspace(process.cwd(), '/opt/npati-project-toolchain', copy).catch(() => null);
  const result = spawnSync('npm', [mode, '--prefer-offline', '--no-audit', '--no-fund'], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
