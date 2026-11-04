import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, openSync } from 'node:fs';
import net from 'node:net';

const common = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net',
  '--uid', '0', '--gid', '0', '--cap-drop', 'ALL', '--die-with-parent', '--new-session'];
const filter = openSync('/opt/npati-runtime/project-command.seccomp', 'r');
const tools = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc',
  '/opt/npati-package-managers', '/opt/npati-project-toolchain', '/opt/npati-qa', '/opt/flutter', '/opt/flutter-glibc',
  '/opt/npati-runtime/prepare-project-dependencies.cjs', '/opt/npati-runtime/project-runtime-inner.mjs'];
const mounts = tools.filter(existsSync).flatMap(p => ['--ro-bind', p, p]);
// Docker must allow this fresh procfs mount (systempaths=unconfined). Keep the
// project's own procfs read-only so kernel controls cannot be changed by code.
const base = [...common, ...mounts, '--proc', '/proc', '--remount-ro', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
const checking = process.argv[2] === '--check';
const [, , uid, project, port, cwd, ...rawCommand] = checking
  ? ['', '', String(process.getuid()), '', '0', '/', '/bin/true'] : process.argv;
const preview = rawCommand[0] === '--preview';
const offline = rawCommand[0] === '--offline';
const command = preview || offline ? rawCommand.slice(1) : rawCommand;
if (!command.length || Number(uid) !== process.getuid()) process.exit(126);
let sandbox, network, temporary;
let exiting = false;
async function finish(code) {
  if (exiting) return;
  exiting = true;
  sandbox?.kill('SIGKILL'); network?.kill('SIGKILL');
  if (temporary) await rm(temporary, { recursive: true, force: true });
  if (checking && code === 0) console.log('namespaces:bubblewrap+slirp4netns');
  process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { void finish(143); });
function dataFrom(stream, child, label) {
  return new Promise((resolve, reject) => {
    let body = '';
    const timer = setTimeout(() => reject(new Error(`${label} setup timed out`)), 10000);
    const done = () => clearTimeout(timer);
    stream.on('data', chunk => { body += chunk; if (label === 'network' || body.includes('}')) { done(); resolve(body); } });
    stream.on('error', error => { done(); reject(error); });
    child.once('error', error => { done(); reject(error); });
    child.once('exit', () => { done(); reject(new Error(`${label} exited before setup`)); });
  });
}
async function forward(socket, port) {
  const occupied = await new Promise(resolve => {
    const connection = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    connection.setTimeout(1000, () => { connection.destroy(); resolve(false); });
    connection.once('connect', () => { connection.destroy(); resolve(true); });
    connection.once('error', () => resolve(false));
  });
  if (occupied) return; // This project's async commands coexist with its preview.
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let body = '';
    client.setTimeout(5000, () => client.destroy(new Error('Preview forwarding timed out')));
    client.on('connect', () => client.end(JSON.stringify({ execute: 'add_hostfwd', arguments: {
      proto: 'tcp', host_addr: '127.0.0.1', host_port: Number(port), guest_addr: '10.0.2.100', guest_port: 59999,
    } })));
    client.on('data', chunk => { body += chunk; });
    client.on('error', reject);
    client.on('end', () => {
      try {
        const response = JSON.parse(body);
        // Async build/test jobs can coexist with this project's active preview.
        // They receive private networks but must not replace its forwarding.
        if (response.error) throw new Error('Project preview forwarding unavailable');
        resolve();
      } catch (error) { reject(error); }
    });
  });
}
try {
  if (offline) {
    // Trusted file sync needs the same filesystem/UID/seccomp boundary, but no
    // network helper. The private network namespace has no external interface.
    sandbox = spawn('/usr/bin/bwrap', [...base, '--bind', project, project, '--chdir', cwd,
      '--seccomp', '3', '--', ...command], { stdio: ['inherit', 'inherit', 'inherit', filter] });
    const code = await new Promise((resolve, reject) => {
      sandbox.once('error', reject);
      sandbox.once('exit', (code, signal) => resolve(code ?? (signal ? 137 : 126)));
    });
    await finish(code);
  }
  // The API socket is outside both the project mount and its private /tmp.
  temporary = await mkdtemp('/tmp/npati-project-network-');
  const socket = `${temporary}/network.sock`;
  const proxy = 'http://10.0.2.2:8080';
  const env = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_proxy', 'npm_config_https_proxy']
    .flatMap(key => ['--setenv', key, proxy]);
  // Native Node fetch must use the same enforced proxy as package managers.
  env.push('--setenv', 'NODE_USE_ENV_PROXY', '1');
  // Preserve access to this project's already-fenced Preview socket. Other
  // projects/control ports remain denied by the existing network policy.
  const noProxy = 'localhost,127.0.0.1,0.0.0.0,::1,10.0.2.2:' + port;
  env.push('--setenv', 'NO_PROXY', noProxy, '--setenv', 'no_proxy', noProxy);
  sandbox = spawn('/usr/bin/bwrap', [...base, ...(checking ? ['--clearenv'] : ['--bind', project, project]), '--chdir', cwd,
    '--info-fd', '3', '--block-fd', '4', '--seccomp', '5', ...env, '--',
    // Only Preview needs the Node relay. Foreground commands execute directly.
    ...(preview ? ['/usr/local/bin/node', '/opt/npati-runtime/project-runtime-inner.mjs', port, ...command] : command)],
    { stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe', filter] });
  // Bubblewrap may fail after reporting its PID but before the release byte.
  // Attach immediately: otherwise that race raises an unhandled EPIPE.
  let releaseError;
  sandbox.stdio[4].on('error', error => { releaseError = error; sandbox.kill('SIGKILL'); });
  const ended = new Promise(resolve => sandbox.once('exit', (code, signal) => resolve(code ?? (signal ? 137 : 126))));
  const info = JSON.parse(await dataFrom(sandbox.stdio[3], sandbox, 'sandbox'));
  network = spawn('/usr/bin/slirp4netns', ['--configure', '--disable-dns', '--mtu=65520', '--ready-fd=3',
    '--exit-fd=4', '--api-socket', socket, String(info['child-pid']), 'tap0'],
    { stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'] });
  await dataFrom(network.stdio[3], network, 'network');
  network.once('exit', () => { if (!exiting) sandbox.kill('SIGKILL'); });
  if (preview) await forward(socket, port);
  if (releaseError) throw releaseError;
  await new Promise((resolve, reject) => {
    sandbox.stdio[4].end('1', error => error ? reject(error) : resolve());
  });
  await finish(await ended);
} catch (error) {
  console.error(`${checking ? 'Project namespaces unavailable' : 'Project namespace setup failed'}: ${error.message}. Check enabled user namespaces, /dev/net/tun and the runner seccomp/AppArmor settings; Landlock is not required.`);
  await finish(126);
}
