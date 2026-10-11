import { spawn } from 'node:child_process';
import net from 'node:net';

// Supports preview servers bound to either localhost or all interfaces.
const [port, executable, ...args] = process.argv.slice(2);
let relay;
if (Number(port)) {
  relay = net.createServer(client => {
    const upstream = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(59999, '0.0.0.0', resolve); });
}
const child = spawn(executable, args, { stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exit(126); });
child.once('exit', (code, signal) => { relay?.close(); process.exit(code ?? (signal ? 137 : 126)); });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
