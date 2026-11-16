import { spawn } from 'node:child_process';
import { SERVER } from './_paths.mjs';

const args = { force: process.argv.includes('--force') };
const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
let id = 0;
function rpc(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    const onData = (buf) => {
      for (const line of buf.toString().split('\n')) {
        const t = line.trim(); if (!t) continue;
        let m; try { m = JSON.parse(t); } catch { continue; }
        if (m.id === myId) { proc.stdout.off('data', onData); resolve(m); }
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => { proc.stdout.off('data', onData); reject(new Error('timeout ' + method)); }, 600000);
  });
}
await rpc('initialize', {});
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const r = await rpc('tools/call', { name: 'atlas_reindex', arguments: args });
console.log(r.result.content[0].text);
proc.stdin.end();
setTimeout(() => { try { proc.kill(); } catch {} process.exit(0); }, 800);
