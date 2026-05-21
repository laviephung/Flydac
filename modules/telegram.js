const axios = require('axios');
const { log } = require('./utils');

// Dien token va chat_id vao day
const TELEGRAM_BOT_TOKEN = 'vào';
const TELEGRAM_CHAT_ID   = 'vào';
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

module.exports = {
  escapeHtml,
  sendTelegram,
  notifyError,
  notifyDailySummary,
  notifyDailyDone,
  notifyTargetBadges,
  notifyFaucetDone,
  notifyFaucetBatchDone,
  notifyCrateBatchDone,
  startTelegramCommandLoop,
};
