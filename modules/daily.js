const { loginWithRetry } = require('./client');
const { buildBadgeStatus, normalizeBadgeNames } = require('./badges');
const { now, fmtDate, fmtTime, log, saveJSON, saveRecordJSON, saveState } = require('./utils');
const { notifyError, notifyDailyDone, notifyTargetBadges } = require('./telegram');

const LOGIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAILY_REQUEST_MAX_RETRY = 3;
const DAILY_RETRY_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getProfile(client) {
  const res = await client.get('https://inception.dachain.io/api/inception/profile/', {
    headers: { 'referer': 'https://inception.dachain.io/dashboard', 'content-type': undefined },
  });
  return res.data;
}

function isRetryableDailyError(err) {
  const status = err.response?.status;
  return status === 429 || status === 503 || (typeof status === 'number' && status >= 500) || !status;
}

function getDailyRetryDelay(attempt) {
  return DAILY_RETRY_DELAY_MS * attempt;
}

async function withDailyRetry(label, wallet, index, total, action, maxRetry = DAILY_REQUEST_MAX_RETRY) {
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      return await action();
    } catch (err) {
      const status = err.response?.status;
      const msg = err.message || 'unknown error';
      log('[DAILY]', `[${index}/${total}] ${wallet.slice(0,10)}... ${label} loi lan ${attempt}/${maxRetry}${status ? ` | HTTP ${status}` : ''}: ${msg}`);
      if (!isRetryableDailyError(err) || attempt === maxRetry) throw err;
      await sleep(getDailyRetryDelay(attempt));
    }
  }
}

async function visitActivity(client, csrfToken) {
  await client.post('https://inception.dachain.io/api/inception/visit/activity/', null, {
    headers: { 'content-type': 'application/json', 'x-csrftoken': csrfToken, 'referer': 'https://inception.dachain.io/activity' },
  });
}

async function claimBadge(client, csrfToken) {
  const res = await client.post('https://inception.dachain.io/api/inception/claim-badge/', null, {
    headers: { 'content-type': 'application/json', 'x-csrftoken': csrfToken, 'referer': 'https://inception.dachain.io/dashboard' },
  });
  return res.data;
}

function didBadgeSetChange(prevNames, nextNames) {
  return JSON.stringify(normalizeBadgeNames(prevNames)) !== JSON.stringify(normalizeBadgeNames(nextNames));
}

async function runDaily(wallet, index, total, proxies, sessions, state, firstRun, options = {}) {
  const { force = false } = options;
  const saved = sessions[wallet];
  const ws = state[wallet] || {};
  const last = ws.last_login || 0;
  const elapsed = now() - last;

  // Skip im lang, khong log
  if (!force && last > 0 && elapsed < LOGIN_INTERVAL_MS) return 'skipped';

  try {
    log('[LOGIN]', `[${index}/${total}] ${wallet.slice(0,10)}... Dang nhap...`);
    const result = await loginWithRetry(wallet, proxies, saved.csrftoken);

    if (!result.success) {
      log('[ERR]', `[${index}/${total}] Login that bai`);
      await notifyError(wallet, 'Login', 'success = false');
      return 'error';
    }

    sessions[wallet].sessionid = result.sessionid;
    sessions[wallet].csrftoken = result.csrftoken;
    saveJSON('sessions.json', sessions);

    // Ghi first_login
    if (!firstRun[wallet]) firstRun[wallet] = {};
    if (!firstRun[wallet].first_login) {
      firstRun[wallet].first_login = now();
      log('[MARK]', `${wallet.slice(0,10)}... First login: ${fmtDate(firstRun[wallet].first_login)}`);
      saveJSON('first_run.json', firstRun);
    }

    // Profile
    const profile = await withDailyRetry('Profile', wallet, index, total, () => getProfile(result.client));
    const xLinked       = profile.x_linked       ? 'OK' : 'NO';
    const discordJoined = profile.discord_joined  ? 'OK' : 'NO';
    const discordLinked = profile.discord_linked  ? 'OK' : 'NO';
    const dacc          = parseFloat(profile.dacc_balance || 0).toFixed(4);
    const badgeStatus   = buildBadgeStatus(profile);
    const targetBadges  = badgeStatus.target_badges;

    const txCount      = profile.tx_count || 0;
    log('[PROF]', `[${index}/${total}] ${wallet.slice(0,10)}... Streak: ${profile.streak_days} | QE: ${profile.qe_balance} | DACC: ${dacc} | TX: ${txCount}`);
    log('[LINK]', `${wallet.slice(0,10)}... X: ${xLinked} | Discord Joined: ${discordJoined} | Discord Linked: ${discordLinked}`);
    if (targetBadges.length > 0) {
      log('[BADGE]', `${wallet.slice(0,10)}... Co badge muc tieu: ${targetBadges.join(', ')}`);
    }

    ws.profile = {
      streak_days:    profile.streak_days,
      qe_balance:     profile.qe_balance,
      dacc_balance:   dacc,
      tx_count:       txCount,
      x_linked:       !!profile.x_linked,
      discord_joined: !!profile.discord_joined,
      discord_linked: !!profile.discord_linked,
      target_badges:  badgeStatus.target_badges,
      minted_badges:  badgeStatus.minted_badges,
      unminted_badges: badgeStatus.unminted_badges,
    };

    if (targetBadges.length > 0 && didBadgeSetChange(ws.target_badges, targetBadges)) {
      await notifyTargetBadges(wallet, targetBadges);
      ws.target_badges_notified_at = now();
    }

    ws.target_badges = targetBadges;
    ws.minted_badges = badgeStatus.minted_badges;
    ws.unminted_badges = badgeStatus.unminted_badges;

    const checkedAt = now();
    const badgeSnapshot = saveRecordJSON('badge_status.json', wallet, {
      wallet,
      target_badges: badgeStatus.target_badges,
      minted_badges: badgeStatus.minted_badges,
      unminted_badges: badgeStatus.unminted_badges,
      last_daily_check_at: checkedAt,
      last_daily_check_at_fmt: fmtDate(checkedAt),
    });

    const pendingConfirmBadges = Array.isArray(badgeSnapshot[wallet]?.pending_confirm_badges)
      ? badgeSnapshot[wallet].pending_confirm_badges
      : [];
    const stillPending = pendingConfirmBadges.filter(item => !badgeStatus.minted_badges.includes(item.name));

    if (stillPending.length !== pendingConfirmBadges.length) {
      saveRecordJSON('badge_status.json', wallet, {
        pending_confirm_badges: stillPending,
      });
    }

    // Visit activity
    await withDailyRetry('Visit activity', wallet, index, total, () => visitActivity(result.client, result.csrftoken));

    // Badge 1 lan
    if (!saved.badge_claimed) {
      try {
        await withDailyRetry('Claim badge', wallet, index, total, () => claimBadge(result.client, result.csrftoken));
        log('[BADGE]', `${wallet.slice(0,10)}... Badge claimed!`);
        sessions[wallet].badge_claimed = true;
        saveJSON('sessions.json', sessions);
      } catch (err) {
        log('[BADGE]', `${wallet.slice(0,10)}... Badge loi: ${err.message}`);
      }
    }

    ws.last_login = now();
    state[wallet] = ws;
    saveState(wallet, ws);

    log('[OK]', `[${index}/${total}] ${wallet.slice(0,10)}... Daily xong`);
    await notifyDailyDone(wallet, ws.profile);
    return 'success';

  } catch (err) {
    log('[ERR]', `[${index}/${total}] Daily loi: ${err.message}`);
    await notifyError(wallet, 'Daily', err.message);
    return 'error';
  }
}

module.exports = { runDaily };
