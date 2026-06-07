#!/usr/bin/env node
// 一键启动：游戏服务器 + SSH外网隧道（零下载，无确认页，打开即玩）
const { spawn, execSync } = require('child_process');
const http = require('http');
const os = require('os');

const PORT = process.env.PORT || 3000;

console.log('');
console.log('  ═══════════════════════════════');
console.log('       🃏  炸 金 花');
console.log('     ⚠️  仅供娱乐 禁止赌博');
console.log('  ═══════════════════════════════');
console.log('');

// 清理旧node进程
try {
  const out = execSync('tasklist /fi "imagename eq node.exe" /fo csv /nh 2>nul', { encoding: 'utf8' });
  out.trim().split('\n').forEach(line => {
    const m = line.match(/"node\.exe","(\d+)"/);
    if (m && parseInt(m[1]) !== process.pid) {
      try { process.kill(parseInt(m[1])); } catch(e) {}
    }
  });
} catch(e) {}

// 启动游戏服务器
const server = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', () => {});
server.stderr.on('data', () => {});

// 等服务器就绪
function waitServer(port) {
  return new Promise(resolve => {
    const check = () => {
      http.get('http://localhost:' + port + '/', { timeout: 1000 }, res => {
        res.resume(); resolve(true);
      }).on('error', () => setTimeout(check, 500));
    };
    check();
  });
}

async function main() {
  await waitServer(PORT);

  // 局域网地址
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  if (ips.length) {
    console.log('  📱 局域网（同一WiFi下）:');
    ips.forEach(ip => console.log('     http://' + ip + ':' + PORT));
    console.log('');
  }

  console.log('  ⏳ 正在生成外网链接...');
  console.log('');

  // 方案1: SSH隧道 serveo.net（零安装，无确认页）
  let tunnelUrl = await trySSHTunnel();

  // 方案2: localtunnel（有确认页但可用）
  if (!tunnelUrl) {
    tunnelUrl = await tryLocaltunnel();
  }

  if (tunnelUrl) {
    console.log('');
    console.log('  ╔════════════════════════════════════════════╗');
    console.log('  ║                                            ║');
    console.log('  ║  👉 ' + tunnelUrl);
    console.log('  ║                                            ║');
    console.log('  ║  📢 把这个链接发给朋友就能玩了！            ║');
    console.log('  ╚════════════════════════════════════════════╝');
  } else {
    console.log('  ❌ 自动隧道失败，请手动:');
    console.log('     下载 ngrok: https://ngrok.com/download');
    console.log('     运行: ngrok http ' + PORT);
  }
  console.log('');
  process.on('SIGINT', () => { server.kill(); process.exit(0); });
}

function trySSHTunnel() {
  return new Promise(resolve => {
    const proc = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=15',
      '-R', '80:localhost:' + PORT,
      'serveo.net'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; proc.kill(); resolve(null); }
    }, 20000);

    const check = (data) => {
      const s = data.toString();
      const m = s.match(/https:\/\/[a-z0-9.-]+\.serveousercontent\.com/);
      if (m && !done) {
        done = true;
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    proc.stdout.on('data', check);
    proc.stderr.on('data', check);
    proc.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
    proc.on('close', () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
  });
}

function tryLocaltunnel() {
  return new Promise(async resolve => {
    try {
      const localTunnel = require('localtunnel');
      const tunnel = await localTunnel({ port: PORT });
      console.log('  ⚠️  使用备用隧道（朋友首次打开需输入页面上的IP数字）');
      resolve(tunnel.url);
    } catch(e) {
      resolve(null);
    }
  });
}

main();
