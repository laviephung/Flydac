const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { log } = require('./utils');

// Doc .env thu cong (khong can cai dotenv)
function loadEnv() {
  const envPath = path.join(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
let telegramOffset = 0;
let commandPolling = false;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getTelegramHelpText() {
  return [
    `[TG] <b>Danh sach lenh</b>`,
    ``,
    `/help - Xem danh sach lenh`,
    `/commands - Xem danh sach lenh`,
    `/status - Xem countdown hien tai`,
    `/wait - Xem countdown hien tai`,
    `/countdown - Xem countdown hien tai`,
    ``,
    `/faucet - Xem trang thai faucet`,
    `/faucet_status - Xem trang thai faucet`,
    `/faucet_on - Bat faucet`,
    `/faucet_off - Tat faucet`,
    ``,
    `/send <so_tx> - Gui token, vi du: /send 50`,
    `/send_stop - Dung lenh send dang chay`,
  ].join('\n');
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN') return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
    });
  } catch (err) {
    log('[TG]', `Telegram loi: ${err.message}`);
  }
}

// Tu dong set menu lenh hien thi khi go / trong Telegram
async function setBotCommands() {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN') return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`, {
      commands: [
        { command: 'help',         description: 'Xem danh sach lenh' },
        { command: 'status',       description: 'Xem countdown hien tai' },
        { command: 'wait',         description: 'Xem countdown hien tai' },
        { command: 'faucet',       description: 'Xem trang thai faucet' },
        { command: 'faucet_on',    description: 'Bat faucet' },
        { command: 'faucet_off',   description: 'Tat faucet' },
        { command: 'faucet_status',description: 'Xem trang thai faucet' },
        { command: 'send',         description: 'Gui token - vi du: /send 50' },
        { command: 'send_stop',    description: 'Dung lenh send dang chay' },
      ],
    });
    log('[TG]', 'Da set bot commands thanh cong');
  } catch (err) {
    log('[TG]', `Set bot commands loi: ${err.message}`);
  }
}

async function fetchTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN') return [];

  try {
    const res = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, {
      params: {
        offset: telegramOffset,
        timeout: 0,
        allowed_updates: JSON.stringify(['message']),
      },
    });
    return res.data?.result || [];
  } catch (err) {
    log('[TG]', `Lay lenh Telegram loi: ${err.message}`);
    return [];
  }
}

function normalizeTelegramCommand(text) {
  const firstToken = String(text || '').trim().split(/\s+/)[0] || '';
  const atIndex = firstToken.indexOf('@');
  return (atIndex >= 0 ? firstToken.slice(0, atIndex) : firstToken).toLowerCase();
}

async function startTelegramCommandLoop(getWaitStatus, isShuttingDown, handlers = {}) {
  if (commandPolling) return;
  commandPolling = true;

  while (!isShuttingDown()) {
    const updates = await fetchTelegramUpdates();

    for (const update of updates) {
      telegramOffset = update.update_id + 1;

      const message = update.message;
      if (!message || String(message.chat?.id) !== TELEGRAM_CHAT_ID) continue;

      const text = (message.text || '').trim();
      if (!text) continue;

      const command = normalizeTelegramCommand(text);

      try {
        if (command === '/help' || command === '/commands' || command === '/menu') {
          await sendTelegram(getTelegramHelpText());
        } else if (command === '/wait' || command === '/countdown' || command === '/status') {
          await sendTelegram(getWaitStatus());
        } else if (command === '/faucet_on') {
          if (typeof handlers.enableFaucet === 'function') {
            await sendTelegram(await handlers.enableFaucet());
          }
        } else if (command === '/faucet_off') {
          if (typeof handlers.disableFaucet === 'function') {
            await sendTelegram(await handlers.disableFaucet());
          }
        } else if (command === '/faucet_status' || command === '/faucet') {
          if (typeof handlers.getFaucetStatus === 'function') {
            await sendTelegram(await handlers.getFaucetStatus());
          }
        } else if (command === '/send') {
          const parts = text.trim().split(/\s+/);
          const txCount = parseInt(parts[1], 10);
          if (!txCount || txCount < 1) {
            await sendTelegram('[SEND] Cu phap sai!\nDung: /send &lt;so_tx&gt;\nVi du: /send 50');
          } else if (typeof handlers.triggerSend === 'function') {
            handlers.triggerSend(txCount).catch(async err => {
              await sendTelegram(`[SEND] <b>Loi khi send</b>\n${escapeHtml(err.message)}`);
            });
          }
        } else if (command === '/send_stop') {
          if (typeof handlers.stopSend === 'function') {
            await sendTelegram(await handlers.stopSend());
          }
        }
      } catch (err) {
        log('[TG]', `Xu ly lenh ${command} loi: ${err.message}`);
        await sendTelegram(`[TG] <b>Lenh loi</b>\nLenh: <code>${escapeHtml(command)}</code>\nLoi: ${escapeHtml(err.message)}`);
      }
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  commandPolling = false;
}

async function notifyError(wallet, task, error) {
  const msg = `[LOI] <b>Loi ${task}</b>\nWallet: <code>${wallet}</code>\nLoi: ${error}`;
  await sendTelegram(msg);
}

async function notifyDailySummary(summary) {
  const lines = [
    `[BAO CAO] <b>Bao cao hang ngay</b>`,
    `Thoi gian: ${new Date().toLocaleString('vi-VN')}`,
    ``,
    `Tong vi: ${summary.total}`,
    `Login thanh cong: ${summary.loginOk}`,
    `Faucet thanh cong: ${summary.faucetOk}`,
    `Hop da mo: ${summary.cratesOpened}`,
    `QE kiem duoc: ${summary.qeEarned}`,
    `Streak cao nhat: ${summary.maxStreak}`,
    ``,
    `Canh bao - Vi chua link: ${summary.notLinked}`,
    `Canh bao - Vi DACC thap: ${summary.lowDacc}`,
  ];
  await sendTelegram(lines.join('\n'));
}

async function notifyDailyDone(wallet, profile) {
  const xLinked       = profile.x_linked       ? 'OK' : 'NO';
  const discordJoined = profile.discord_joined  ? 'OK' : 'NO';
  const discordLinked = profile.discord_linked  ? 'OK' : 'NO';
  const msg = [
    `[OK] <b>Daily xong</b>`,
    `Wallet: <code>${wallet}</code>`,
    `Streak: ${profile.streak_days} ngay`,
    `QE: ${profile.qe_balance}`,
    `DACC: ${profile.dacc_balance}`,
    `X: ${xLinked} | Discord Join: ${discordJoined} | Discord Link: ${discordLinked}`,
    `Thoi gian: ${new Date().toLocaleString('vi-VN')}`,
  ].join('\n');
  await sendTelegram(msg);
}

async function notifyTargetBadges(wallet, badgeNames) {
  if (!Array.isArray(badgeNames) || badgeNames.length === 0) return;

  const msg = [
    `[BADGE] <b>Vi co badge muc tieu</b>`,
    `Wallet: <code>${wallet}</code>`,
    `Badge: ${badgeNames.join(', ')}`,
    `Thoi gian: ${new Date().toLocaleString('vi-VN')}`,
  ].join('\n');

  await sendTelegram(msg);
}

async function notifyFaucetDone(wallet, data, profile) {
  const amount  = data?.amount  ?? data?.dacc ?? data?.reward ?? JSON.stringify(data);
  const balance = data?.balance ?? data?.dacc_balance ?? null;
  const xLinked       = profile?.x_linked       ? 'OK' : 'NO';
  const discordJoined = profile?.discord_joined  ? 'OK' : 'NO';
  const discordLinked = profile?.discord_linked  ? 'OK' : 'NO';

  const lines = [
    `[OK] <b>Faucet xong</b>`,
    `Wallet: <code>${wallet}</code>`,
    `Nhan duoc: ${amount}`,
  ];

  if (balance !== null) lines.push(`So du: ${balance}`);

  lines.push(
    `X: ${xLinked} | Discord Join: ${discordJoined} | Discord Link: ${discordLinked}`,
    `Thoi gian: ${new Date().toLocaleString('vi-VN')}`,
  );

  await sendTelegram(lines.join('\n'));
}

async function notifyFaucetBatchDone(stats) {
  const attempted = stats.success + stats.error;
  const lines = [
    `[OK] <b>Faucet done</b>`,
    `Done: ${stats.success}/${attempted} vi`,
    `Loi: ${stats.error} vi`,
    `Skip: ${stats.skipped} vi`,
    `Tong: ${stats.total} vi`,
    `Thoi gian: ${new Date().toLocaleString('vi-VN')}`,
  ];
  await sendTelegram(lines.join('\n'));
}

async function notifyCrateBatchDone(stats) {
  const attempted = stats.success + stats.error;
  const lines = [
    `[OK] <b>Crate done</b>`,
    `Done: ${stats.success}/${attempted} vi`,
    `Loi: ${stats.error} vi`,
    `Skip: ${stats.skipped} vi`,
    `Tong: ${stats.total} vi`,
    `Thoi gian: ${new Date().toLocaleString('vi-VN')}`,
  ];
  await sendTelegram(lines.join('\n'));
}

async function notifySendStart(txCount, totalWallets) {
  const msg = [
    `[SEND] <b>Bat dau send</b>`,
    `Vi gui: ${totalWallets}`,
    `TX moi vi: ${txCount}`,
    `Tong TX du kien: ${txCount * totalWallets}`,
    `Thoi gian: ${new Date().toLocaleString('vi-VN')}`,
  ].join('\n');
  await sendTelegram(msg);
}

async function notifySendDone(stats) {
  const lines = [
    `[OK] <b>Send hoan thanh</b>`,
    `Vi gui: ${stats.totalWallets}`,
    `TX moi vi: ${stats.txPerWallet}`,
    `Tong TX: ${stats.totalTx}`,
    `Thanh cong: ${stats.success}`,
    `That bai: ${stats.fail}`,
    `Thoi gian: ${new Date().toLocaleString('vi-VN')}`,
  ];
  await sendTelegram(lines.join('\n'));
}

async function notifyAutoSendStart(walletCount, walletDetails) {
  const detailLines = walletDetails.slice(0, 10).map(w =>
    `  <code>${w.address.slice(0, 10)}...</code> TX: ${w.currentTx} → can ${w.txNeeded} tx`
  );
  if (walletDetails.length > 10) {
    detailLines.push(`  ... va ${walletDetails.length - 10} vi khac`);
  }
  const msg = [
    `[AUTO-SEND] <b>Tu dong gui TX</b>`,
    `Vi chua du 50 TX: ${walletCount}`,
    ``,
    ...detailLines,
    ``,
    `Thoi gian: ${new Date().toLocaleString('vi-VN')}`,
  ].join('\n');
  await sendTelegram(msg);
}

async function notifyAutoSendDone(stats) {
  if (stats.skipped) {
    await sendTelegram(`[AUTO-SEND] Tat ca vi da du 50 TX ✅`);
    return;
  }
  const lines = [
    `[AUTO-SEND] <b>Auto send hoan thanh</b>`,
    `Vi da gui: ${stats.totalWallets}`,
    `TX thanh cong: ${stats.success}`,
    `TX that bai: ${stats.fail}`,
    `Thoi gian: ${new Date().toLocaleString('vi-VN')}`,
  ];
  await sendTelegram(lines.join('\n'));
}

module.exports = {
  escapeHtml,
  sendTelegram,
  setBotCommands,
  notifyError,
  notifyDailySummary,
  notifyDailyDone,
  notifyTargetBadges,
  notifyFaucetDone,
  notifyFaucetBatchDone,
  notifyCrateBatchDone,
  notifySendStart,
  notifySendDone,
  notifyAutoSendStart,
  notifyAutoSendDone,
  startTelegramCommandLoop,
};
