const { loadFile, loadJSON, saveJSON, writeOutput, now, fmtDate, fmtTime, log } = require('./modules/utils');
const { runDaily }     = require('./modules/daily');
const { runFaucet }    = require('./modules/faucet');
const { runCrateLoop } = require('./modules/crate');
const { runSend, runAutoSend, TX_TARGET } = require('./modules/send');
const { escapeHtml, sendTelegram, setBotCommands, notifyDailySummary, notifyFaucetBatchDone, notifyCrateBatchDone, notifySendStart, notifySendDone, notifyAutoSendStart, notifyAutoSendDone, startTelegramCommandLoop } = require('./modules/telegram');

const DAILY_INTERVAL_MS       = 24 * 60 * 60 * 1000;
const CRATE_INTERVAL_MS       = 24 * 60 * 60 * 1000;
const CRATE_RETRY_INTERVAL_MS = 10 * 60 * 1000;
const SUMMARY_INTERVAL_MS     = 24 * 60 * 60 * 1000;
const SAIGON_OFFSET_MS        = 7 * 60 * 60 * 1000;
const DAILY_TARGET_HOUR       = 9;

let isShuttingDown = false;
const activeCountdowns = new Map();
const dueNowScopes = new Set();
let featureFlags = loadJSON('feature_flags.json');
let initialDailyRunPending = true;
let nextDailyRunAt = 0;

function isFaucetEnabled() {
  return featureFlags.faucet_enabled !== false;
}

function saveFeatureFlags() {
  saveJSON('feature_flags.json', featureFlags);
}

async function enableFaucet() {
  featureFlags.faucet_enabled = true;
  saveFeatureFlags();
  log('[TG]', 'Da bat faucet qua Telegram');
  return '[TG] Faucet da BAT';
}

async function disableFaucet() {
  featureFlags.faucet_enabled = false;
  saveFeatureFlags();
  log('[TG]', 'Da tat faucet qua Telegram');
  return '[TG] Faucet da TAT';
}

async function getFaucetStatus() {
  return `[TG] Faucet hien dang: ${isFaucetEnabled() ? 'BAT' : 'TAT'}`;
}

// --- Send ---

let sendInProgress = false;
let sendShouldStop = false;

async function triggerSend(txCount) {
  if (sendInProgress) {
    await sendTelegram('[SEND] Dang co lenh send chay roi, vui long cho xong hoac /send_stop');
    return;
  }

  sendInProgress = true;
  sendShouldStop = false;

  const privateKeys = loadFile('private.txt');
  await notifySendStart(txCount, privateKeys.length);

  try {
    const stats = await runSend(txCount, () => sendShouldStop || isShuttingDown);
    await notifySendDone(stats);
  } catch (err) {
    log('[SEND]', `triggerSend loi: ${err.message}`);
    await sendTelegram(`[SEND] <b>Loi khi send</b>\n${escapeHtml(err.message)}`);
  } finally {
    sendInProgress = false;
    sendShouldStop = false;
  }
}

async function stopSend() {
  if (!sendInProgress) return '[SEND] Khong co lenh send nao dang chay';
  sendShouldStop = true;
  log('[SEND]', 'Nhan lenh dung send qua Telegram');
  return '[SEND] Dang dung send, vui long cho batch hien tai hoan thanh...';
}

function renderCountdowns() {
  if (!process.stdout.isTTY) return;

  const entries = [...activeCountdowns.entries()]
    .map(([scope, dueAt]) => ({ scope, dueAt, remainMs: Math.max(0, dueAt - now()) }))
    .filter(entry => entry.remainMs > 0)
    .sort((a, b) => a.dueAt - b.dueAt);
  const dueEntries = [...dueNowScopes].sort().map(scope => ({ scope, label: 'den gio' }));

  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);

  if (entries.length === 0 && dueEntries.length === 0) return;

  const line = `[WAIT] ${[
    ...dueEntries.map(entry => `[${entry.scope}] ${entry.label}`),
    ...entries.map(entry => `[${entry.scope}] ${fmtTime(entry.remainMs)}`),
  ].join(' | ')}`;
  process.stdout.write(line);
}

function getWaitStatus() {
  const entries = [...activeCountdowns.entries()]
    .map(([scope, dueAt]) => ({ scope, dueAt, remainMs: Math.max(0, dueAt - now()) }))
    .filter(entry => entry.remainMs > 0)
    .sort((a, b) => a.dueAt - b.dueAt);
  const dueEntries = [...dueNowScopes].sort().map(scope => ({ scope, label: 'den gio' }));

  if (entries.length === 0 && dueEntries.length === 0) {
    return '[WAIT] Khong co countdown nao dang chay';
  }

  return `[WAIT] ${[
    ...dueEntries.map(entry => `[${entry.scope}] ${entry.label}`),
    ...entries.map(entry => `[${entry.scope}] ${fmtTime(entry.remainMs)}`),
  ].join(' | ')}`;
}

function setCountdown(scope, dueAt) {
  dueNowScopes.delete(scope);
  activeCountdowns.set(scope, dueAt);
  renderCountdowns();
}

function clearCountdown(scope) {
  activeCountdowns.delete(scope);
  dueNowScopes.delete(scope);
  renderCountdowns();
}

function markDueNow(scope) {
  activeCountdowns.delete(scope);
  dueNowScopes.add(scope);
  renderCountdowns();
}

// --- Graceful Shutdown ---

async function shutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('[STOP]', `Tool dang tat (${reason}), luu du lieu...`);
  await Promise.race([
    sendTelegram(`[STOP] <b>Tool da tat</b>\nLy do: ${reason}\nThoi gian: ${fmtDate(now())}`),
    new Promise(r => setTimeout(r, 3000)),
  ]);
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', async (err) => {
  log('[CRASH]', `Loi khong xu ly: ${err.message}`);
  await Promise.race([
    sendTelegram(`[CRASH] <b>Tool crash!</b>\nLoi: ${escapeHtml(err.message)}`),
    new Promise(r => setTimeout(r, 3000)),
  ]);
  process.exit(1);
});
process.on('unhandledRejection', async (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log('[REJECT]', `Promise loi khong xu ly: ${err.message}`);
  await Promise.race([
    sendTelegram(`[CRASH] <b>Promise crash!</b>\nLoi: ${escapeHtml(err.message)}`),
    new Promise(r => setTimeout(r, 3000)),
  ]);
  process.exit(1);
});

// --- Warning Files ---

function writeWarningFiles(state) {
  const notLinked = [];
  const lowDacc   = [];
  const lowTx     = [];

  for (const [wallet, ws] of Object.entries(state)) {
    if (wallet === '_meta' || !ws.profile) continue;
    const p = ws.profile;

    if (!p.x_linked || !p.discord_joined || !p.discord_linked) {
      const reasons = [];
      if (!p.x_linked)       reasons.push('X chua link');
      if (!p.discord_joined) reasons.push('Discord chua join');
      if (!p.discord_linked) reasons.push('Discord chua link');
      notLinked.push(`${wallet} | ${reasons.join(', ')}`);
    }

    if (parseFloat(p.dacc_balance) < 1) {
      lowDacc.push(`${wallet} | DACC: ${p.dacc_balance}`);
    }

    const txCount = p.tx_count || 0;
    if (txCount < TX_TARGET) {
      lowTx.push(`${wallet} | TX: ${txCount}/${TX_TARGET} (can ${TX_TARGET - txCount} tx)`);
    }
  }

  writeOutput('warning_not_linked.txt', notLinked.length > 0 ? notLinked : ['Tat ca da link day du!']);
  writeOutput('warning_low_dacc.txt',   lowDacc.length   > 0 ? lowDacc   : ['Tat ca DACC >= 1!']);
  writeOutput('warning_low_tx.txt',     lowTx.length     > 0 ? lowTx     : [`Tat ca da du ${TX_TARGET} TX!`]);
  log('[WARN]', `Warning: ${notLinked.length} vi chua link | ${lowDacc.length} vi DACC thap | ${lowTx.length} vi chua du ${TX_TARGET} TX`);

  return { notLinked: notLinked.length, lowDacc: lowDacc.length, lowTx: lowTx.length };
}

function buildSummary(state, wallets) {
  let loginOk = 0, faucetOk = 0, cratesOpened = 0, qeEarned = 0, maxStreak = 0;

  for (const wallet of wallets) {
    const ws = state[wallet.toLowerCase()];
    if (!ws) continue;
    if (ws.last_login)     loginOk++;
    if (ws.last_faucet)    faucetOk++;
    if (ws.last_qe_earned) qeEarned += ws.last_qe_earned;
    if (ws.profile?.streak_days > maxStreak) maxStreak = ws.profile.streak_days;
  }

  return { total: wallets.length, loginOk, faucetOk, cratesOpened, qeEarned, maxStreak };
}

// --- Tinh thoi gian cho den vi sap den han nhat ---

function calcWaitMs(wallets, state, lastKey, intervalMs) {
  let nearestNext = Infinity;
  let hasAnyCompleted = false;

  for (const w of wallets) {
    const ws = state[w.toLowerCase()];
    if (!ws) continue;
    const last = ws[lastKey] || 0;
    if (last === 0) continue;
    hasAnyCompleted = true;
    const next = last + intervalMs;
    if (next < nearestNext) nearestNext = next;
  }

  if (!hasAnyCompleted) return 60 * 1000;
  if (nearestNext === Infinity) return 60 * 1000;
  const wait = nearestNext - now();
  return wait > 0 ? wait : 0;
}

function calcNextDailyRunAt(fromTs = now()) {
  const shiftedNow = new Date(fromTs + SAIGON_OFFSET_MS);
  const targetTodayShifted = Date.UTC(
    shiftedNow.getUTCFullYear(),
    shiftedNow.getUTCMonth(),
    shiftedNow.getUTCDate(),
    DAILY_TARGET_HOUR, 0, 0, 0
  );

  const currentShiftedTs = shiftedNow.getTime();
  const targetShiftedTs = currentShiftedTs < targetTodayShifted
    ? targetTodayShifted
    : targetTodayShifted + DAILY_INTERVAL_MS;

  return targetShiftedTs - SAIGON_OFFSET_MS;
}

function calcDailyScheduleWaitMs() {
  if (initialDailyRunPending) return 0;
  const dueAt = nextDailyRunAt || calcNextDailyRunAt(now());
  return Math.max(0, dueAt - now());
}

function calcCrateWaitMs(wallets, state) {
  let nearestRetry = Infinity;
  let hasIncomplete = false;

  for (const w of wallets) {
    const ws = state[w.toLowerCase()];
    if (!ws || !ws.crate_incomplete) continue;
    hasIncomplete = true;
    const retryAt = (ws.last_crate_retry_at || 0) + CRATE_RETRY_INTERVAL_MS;
    if (retryAt < nearestRetry) nearestRetry = retryAt;
  }

  if (hasIncomplete) {
    const wait = nearestRetry - now();
    return wait > 0 ? wait : 0;
  }

  return calcWaitMs(wallets, state, 'last_crate_opened_at', CRATE_INTERVAL_MS);
}

function calcFaucetWaitMs(wallets, state) {
  if (!isFaucetEnabled()) return null;

  let nearestFuture = Infinity;
  let hasEligibleWallet = false;
  let hasReadyNow = false;

  for (const w of wallets) {
    const ws = state[w.toLowerCase()];
    if (!ws) continue;

    const profile = ws.profile || {};
    const hasX = !!profile.x_linked;
    const hasDiscord = !!profile.discord_joined && !!profile.discord_linked;

    // Giong runFaucet: bo qua cac vi khong du dieu kien claim faucet.
    if (!hasX && !hasDiscord) continue;

    hasEligibleWallet = true;

    const faucetNextAt = ws.faucet_next_at || 0;
    if (faucetNextAt <= 0) {
      hasReadyNow = true;
      continue;
    }

    if (faucetNextAt <= now()) {
      hasReadyNow = true;
      continue;
    }

    if (faucetNextAt < nearestFuture) nearestFuture = faucetNextAt;
  }

  if (nearestFuture !== Infinity) {
    return Math.max(0, nearestFuture - now());
  }

  if (hasReadyNow) return 0;
  if (!hasEligibleWallet) return 60 * 1000;
  return 60 * 1000;
}

// --- FIX: waitForCountdowns chi break khi scope SOM NHAT den han ---
// Truoc day: break ngay khi BAT KY scope nao het gio → cac scope con lai bi mat khoi man hinh
// Sau fix: chi break khi scope co dueAt nho nhat het gio, cac scope khac van hien thi binh thuong

async function waitForCountdowns(countdowns) {
  const dueTimes = countdowns
    .map(({ scope, waitMs }) => ({ scope, waitMs, dueAt: now() + Math.max(0, waitMs) }));

  if (dueTimes.length === 0) return;

  for (const { scope, waitMs } of dueTimes) {
    if (waitMs <= 0) markDueNow(scope);
  }

  const pendingDueTimes = dueTimes.filter(({ waitMs }) => waitMs > 0);
  if (pendingDueTimes.length === 0) return;

  // Dang ky tat ca scope vao activeCountdowns ngay lap tuc de hien thi
  for (const { scope, dueAt } of pendingDueTimes) {
    setCountdown(scope, dueAt);
  }

  // Tim scope den han som nhat de lam moc thoat vong lap
  const earliest = pendingDueTimes.reduce((a, b) => a.dueAt < b.dueAt ? a : b);

  while (!isShuttingDown) {
    const currentNow = now();
    const remainMs = earliest.dueAt - currentNow;

    if (remainMs <= 0) {
      // Scope som nhat da den han -> danh dau den gio, log, thoat
      markDueNow(earliest.scope);
      log('[WAIT]', `[${earliest.scope}] Den gio chay lai`);
      break;
    }

    // Cap nhat tat ca scope con lai (ke ca scope chua den han) de man hinh luon moi
    for (const { scope, dueAt } of pendingDueTimes) {
      if (dueAt - currentNow > 0) {
        setCountdown(scope, dueAt);
      }
    }

    await new Promise(r => setTimeout(r, Math.min(1000, remainMs)));
  }

  // Neu shutdown thi clear het, khong de countdown "treo" tren man hinh
  if (isShuttingDown) {
    for (const { scope } of dueTimes) {
      clearCountdown(scope);
    }
  }
}

// --- Loop 1: Daily + Faucet ---

async function dailyFaucetLoop() {
  while (!isShuttingDown) {
    const wallets  = loadFile('wallets.txt');
    const proxies  = loadFile('proxies.txt');
    const sessions = loadJSON('sessions.json');
    const state    = loadJSON('state.json');
    const firstRun = loadJSON('first_run.json');
    const dailyRefreshedWallets = new Set();

    log('[LOOP]', `[Daily/Faucet] Check ${wallets.length} wallets...`);
    const faucetEnabled = isFaucetEnabled();
    const faucetStats = { total: wallets.length, success: 0, error: 0, skipped: 0 };
    const shouldRunDaily = initialDailyRunPending || now() >= nextDailyRunAt;

    for (let i = 0; i < wallets.length; i++) {
      if (isShuttingDown) break;
      const wallet = wallets[i].toLowerCase();

      if (!sessions[wallet]) continue;
      if (!state[wallet]) state[wallet] = {};

      if (shouldRunDaily) {
        const dailyStatus = await runDaily(wallet, i + 1, wallets.length, proxies, sessions, state, firstRun, { force: true });
        if (dailyStatus === 'success') {
          dailyRefreshedWallets.add(wallet);
        }
      }
      if (!faucetEnabled) {
        continue;
      }

      const faucetStatus = await runFaucet(wallet, i + 1, wallets.length, proxies, sessions, state, firstRun);
      if (faucetStatus === 'success') faucetStats.success++;
      else if (faucetStatus === 'error') faucetStats.error++;
      else faucetStats.skipped++;
    }

    writeWarningFiles(loadJSON('state.json'));
    if (shouldRunDaily) {
      initialDailyRunPending = false;
      nextDailyRunAt = calcNextDailyRunAt(now());
      log('[DAILY]', `Lan daily tiep theo luc ${fmtDate(nextDailyRunAt)}`);

      // --- Auto Send: gui tx cho vi chua du TX_TARGET ---
      if (!isShuttingDown && !sendInProgress) {
        try {
          const autoSendState = loadJSON('state.json');
          const walletTxMap = {};
          const walletDetails = [];

          for (const wallet of dailyRefreshedWallets) {
            const ws = autoSendState[wallet];
            if (!ws?.profile) continue;
            const txCount = ws.profile.tx_count || 0;
            if (txCount < TX_TARGET) {
              const txNeeded = TX_TARGET - txCount;
              walletTxMap[wallet] = txNeeded;
              walletDetails.push({ address: wallet, currentTx: txCount, txNeeded });
            }
          }

          if (walletDetails.length > 0) {
            log('[AUTO-SEND]', `Tim thay ${walletDetails.length} vi chua du ${TX_TARGET} TX, bat dau auto send...`);
            await notifyAutoSendStart(walletDetails.length, walletDetails);

            sendInProgress = true;
            try {
              const autoStats = await runAutoSend(walletTxMap, () => sendShouldStop || isShuttingDown);
              await notifyAutoSendDone(autoStats);
            } finally {
              sendInProgress = false;
              sendShouldStop = false;
            }
          } else {
            log('[AUTO-SEND]', `Tat ca vi da du ${TX_TARGET} TX`);
          }
        } catch (err) {
          log('[AUTO-SEND]', `Loi auto send: ${err.message}`);
          await sendTelegram(`[AUTO-SEND] <b>Loi</b>\n${escapeHtml(err.message)}`);
        }
      }
    }

    if (faucetEnabled) {
      await notifyFaucetBatchDone(faucetStats);
    }

    const freshState = loadJSON('state.json');
    const waitDaily  = calcDailyScheduleWaitMs();
    const waitFaucet = calcFaucetWaitMs(wallets, freshState);

    const countdowns = [
      { scope: 'Daily', waitMs: waitDaily },
    ];

    if (typeof waitFaucet === 'number') {
      countdowns.push({ scope: 'Faucet', waitMs: waitFaucet });
    } else {
      clearCountdown('Faucet');
    }

    if (countdowns.some(entry => entry.waitMs > 0)) {
      await waitForCountdowns(countdowns);
    }
  }
}

// --- Loop 2: Crate ---

async function crateLoop() {
  while (!isShuttingDown) {
    const wallets  = loadFile('wallets.txt');
    const proxies  = loadFile('proxies.txt');
    const sessions = loadJSON('sessions.json');
    const state    = loadJSON('state.json');
    const firstRun = loadJSON('first_run.json');

    log('[LOOP]', `[Crate] Check ${wallets.length} wallets...`);
    const crateStats = await runCrateLoop(wallets, proxies, sessions, state, firstRun);
    await notifyCrateBatchDone(crateStats);

    const freshState = loadJSON('state.json');
    const waitMs     = calcCrateWaitMs(wallets, freshState);

    if (waitMs > 0) {
      await waitForCountdowns([{ scope: 'Crate', waitMs }]);
    }
  }
}

// --- Loop 3: Daily Summary Telegram ---

async function summaryLoop() {
  while (!isShuttingDown) {
    const start = now();
    while (!isShuttingDown && now() - start < SUMMARY_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, 1000));
    }
    if (isShuttingDown) break;

    const wallets = loadFile('wallets.txt');
    const state   = loadJSON('state.json');
    const summary = buildSummary(state, wallets);
    const { notLinked, lowDacc } = writeWarningFiles(state);

    await notifyDailySummary({ ...summary, notLinked, lowDacc });
    log('[STAT]', 'Da gui bao cao hang ngay qua Telegram');
  }
}

// --- Main ---

async function main() {
  log('[START]', `Tool khoi dong luc ${fmtDate(now())}`);
  await setBotCommands();
  await sendTelegram(`[START] <b>Tool khoi dong</b>\nThoi gian: ${fmtDate(now())}`);

  const firstRun = loadJSON('first_run.json');
  if (!firstRun._meta) {
    firstRun._meta = { start_time: now(), start_time_fmt: fmtDate(now()) };
    saveJSON('first_run.json', firstRun);
    log('[MARK]', `Ghi nho thoi diem khoi dong: ${fmtDate(firstRun._meta.start_time)}`);
  }

  await Promise.all([
    dailyFaucetLoop(),
    crateLoop(),
    summaryLoop(),
    startTelegramCommandLoop(getWaitStatus, () => isShuttingDown, {
      enableFaucet,
      disableFaucet,
      getFaucetStatus,
      triggerSend,
      stopSend,
    }),
  ]);
}

main().catch(async (err) => {
  log('[CRASH]', `Main crash: ${err.message}`);
  await Promise.race([
    sendTelegram(`[CRASH] <b>Tool crash!</b>\n${escapeHtml(err.message)}`),
    new Promise(r => setTimeout(r, 3000)),
  ]);
  process.exit(1);
});
