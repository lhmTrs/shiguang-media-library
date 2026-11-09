import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const [stateFile, controlPath] = process.argv.slice(2);
const record = event => fs.appendFileSync(`${stateFile}.events`, JSON.stringify({pid:process.pid, ...event}) + '\n');
const server = http.createServer((_req, res) => res.end('OWNED_FIXTURE'));
const control = net.createServer(socket => socket.on('data', data => {
  if (data.toString().trim() === 'EXIT') { socket.end('OK'); stop('IPC'); }
}));
let stopping = false;
function stop(reason) {
  if (stopping) return;
  stopping = true;
  record({event:'stopping', reason});
  control.close(() => record({event:'control-closed'}));
  server.close(() => record({event:'http-closed'}));
}
process.on('SIGTERM', () => stop('SIGTERM'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => control.listen(controlPath, resolve));
fs.writeFileSync(stateFile, JSON.stringify({pid:process.pid, ppid:process.ppid, port:server.address().port, controlPath}));
process.on('beforeExit', code => record({event:'before-exit', code}));
process.on('exit', code => record({event:'exit', code}));
