const fs = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '../data');
const OUTPUT_DIR = path.join(__dirname, '../output');

if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function loadFile(filename) {
  return fs.readFileSync(filename, 'utf-8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

function loadJSON(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return {};
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

function saveJSON(filename, data) {
  const fp = path.join(DATA_DIR, filename);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function saveRecordJSON(filename, key, updates) {
  const fp = path.join(DATA_DIR, filename);
  const fresh = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf-8')) : {};
  if (!fresh[key]) fresh[key] = {};
  Object.assign(fresh[key], updates);
  fs.writeFileSync(fp, JSON.stringify(fresh, null, 2));
  return fresh;
}

// Ghi state.json an toan: doc lai file moi nhat -> merge wallet data -> ghi lai
// Tranh race condition khi 2 loop chay song song ghi de lan nhau
function saveState(wallet, updates) {
  const fp = path.join(DATA_DIR, 'state.json');
  const fresh = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf-8')) : {};
  if (!fresh[wallet]) fresh[wallet] = {};
  Object.assign(fresh[wallet], updates);
  fs.writeFileSync(fp, JSON.stringify(fresh, null, 2));
  return fresh;
}

function writeOutput(filename, lines) {
  const fp = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(fp, lines.join('\n'), 'utf-8');
}

function now() { return Date.now(); }

function fmtDate(ts) {
  if (!ts) return 'chua co';
  return new Date(ts).toLocaleString('vi-VN');
}

function fmtTime(ms) {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h > 0 ? h + 'h' : ''}${m % 60 > 0 ? (m % 60) + 'm' : ''}${s % 60}s`;
}

function log(tag, msg) {
  const t = new Date().toLocaleString('vi-VN');
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
  console.log(`[${t}] ${tag} ${msg}`);
}

function parseProxy(proxyLine) {
  const [host, port, user, pass] = proxyLine.trim().split(':');
  return `http://${user}:${pass}@${host}:${port}`;
}

module.exports = {
  loadFile, loadJSON, saveJSON, saveRecordJSON, saveState, writeOutput,
  now, fmtDate, fmtTime, log, parseProxy,
};
