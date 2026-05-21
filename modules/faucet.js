const { loginWithRetry } = require('./client');
const { now, fmtDate, fmtTime, log, saveJSON, saveState } = require('./utils');
const PRE_VISIT_DELAY_MIN_MS = 3000;
const PRE_VISIT_DELAY_MAX_MS = 7000;
const BETWEEN_REQUEST_DELAY_MIN_MS = 4000;
const BETWEEN_REQUEST_DELAY_MAX_MS = 8000;
const FAUCET_RETRY_DELAY_MS = 15000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomMs(min, max) {
  return min + Math.random() * (max - min);
}

function isRateLimit(err) {
  return err.response?.status === 429;
}

async function getProfile(client) {
  const res = await client.get('https://inception.dachain.io/api/inception/profile/', {
    headers: { 'referer': 'https://inception.dachain.io/dashboard', 'content-type': undefined },
  });
  return res.data;
}

async function postFaucet(client, csrfToken) {
  return client.post('https://inception.dachain.io/api/inception/faucet/', null, {
    headers: { 'content-type': 'application/json', 'x-csrftoken': csrfToken, 'referer': 'https://inception.dachain.io/faucet' },
  });
}

async function runFaucet(wallet, index, total, proxies, sessions, state, firstRun) {
  const saved = sessions[wallet];
  const ws = state[wallet] || {};

  // Chi skip neu chua link ca X lan Discord
  const profile = ws.profile || {};
  const hasX       = !!profile.x_linked;
  const hasDiscord = !!profile.discord_joined && !!profile.discord_linked;

  if (!hasX && !hasDiscord) {
    log('[FAUCET]', `[${index}/${total}] ${wallet.slice(0,10)}... Faucet skip | chua link X lan Discord`);
    return 'skipped';
  }

  try {
    log('[FAUCET]', `[${index}/${total}] ${wallet.slice(0,10)}... Faucet login...`);
    const result = await loginWithRetry(wallet, proxies, saved.csrftoken);
    sessions[wallet].sessionid = result.sessionid;
    sessions[wallet].csrftoken = result.csrftoken;
    saveJSON('sessions.json', sessions);

    log('[FAUCET]', `[${index}/${total}] ${wallet.slice(0,10)}... Check profile faucet...`);
    const profile = await getProfile(result.client);
    const faucetSecondsLeft = Number(profile.faucet_seconds_left || 0);
    const checkedAt = now();
    const faucetNextAt = checkedAt + (faucetSecondsLeft * 1000);
    ws.profile = {
      ...(ws.profile || {}),
      streak_days: profile.streak_days,
      qe_balance: profile.qe_balance,
      dacc_balance: parseFloat(profile.dacc_balance || 0).toFixed(4),
      x_linked: !!profile.x_linked,
      discord_joined: !!profile.discord_joined,
      discord_linked: !!profile.discord_linked,
      faucet_seconds_left: faucetSecondsLeft,
    };
    ws.faucet_checked_at = checkedAt;
    ws.faucet_next_at = faucetNextAt;

    if (faucetSecondsLeft > 0) {
      state[wallet] = ws;
      saveState(wallet, ws);
      log('[FAUCET]', `[${index}/${total}] ${wallet.slice(0,10)}... Faucet skip | server con: ${fmtTime(faucetSecondsLeft * 1000)}`);
      return 'skipped';
    }

    const preVisitDelay = randomMs(PRE_VISIT_DELAY_MIN_MS, PRE_VISIT_DELAY_MAX_MS);
    log('[FAUCET]', `[${index}/${total}] ${wallet.slice(0,10)}... Cho ${(preVisitDelay / 1000).toFixed(1)}s truoc visit faucet...`);
    await sleep(preVisitDelay);

    await result.client.post('https://inception.dachain.io/api/inception/visit/faucet/', null, {
      headers: { 'content-type': 'application/json', 'x-csrftoken': result.csrftoken, 'referer': 'https://inception.dachain.io/faucet' },
    });

    const betweenDelay = randomMs(BETWEEN_REQUEST_DELAY_MIN_MS, BETWEEN_REQUEST_DELAY_MAX_MS);
    log('[FAUCET]', `[${index}/${total}] ${wallet.slice(0,10)}... Cho ${(betweenDelay / 1000).toFixed(1)}s truoc claim faucet...`);
    await sleep(betweenDelay);

    let faucet;
    try {
      faucet = await postFaucet(result.client, result.csrftoken);
    } catch (err) {
      if (!isRateLimit(err)) throw err;
      log('[FAUCET]', `[${index}/${total}] ${wallet.slice(0,10)}... Dinh 429, cho ${fmtTime(FAUCET_RETRY_DELAY_MS)} roi thu lai...`);
      await sleep(FAUCET_RETRY_DELAY_MS);
      faucet = await postFaucet(result.client, result.csrftoken);
    }

    try {
      await postFaucet(result.client, result.csrftoken);
      log('[FAUCET]', `[${index}/${total}] ${wallet.slice(0,10)}... Check claim lan 2: van tra ve binh thuong`);
    } catch (err) {
      if (isRateLimit(err)) {
        log('[FAUCET]', `[${index}/${total}] ${wallet.slice(0,10)}... Check claim lan 2: da 429, dung nhu ky vong`);
      } else {
        throw err;
      }
    }

    // Ghi first_faucet
    if (!firstRun[wallet]) firstRun[wallet] = {};
    if (!firstRun[wallet].first_faucet) {
      firstRun[wallet].first_faucet = now();
      log('[MARK]', `${wallet.slice(0,10)}... First faucet: ${fmtDate(firstRun[wallet].first_faucet)}`);
      saveJSON('first_run.json', firstRun);
    }

    const claimedAt = now();
    ws.last_faucet = claimedAt;
    ws.faucet_checked_at = claimedAt;
    ws.faucet_next_at = claimedAt;
    ws.profile = {
      ...(ws.profile || {}),
      faucet_seconds_left: 0,
    };
    state[wallet] = ws;
    saveState(wallet, ws);

    log('[FAUCET]', `[${index}/${total}] ${wallet.slice(0,10)}... Faucet OK | ${JSON.stringify(faucet.data)}`);
    return 'success';

  } catch (err) {
    log('[FAUCET]', `[${index}/${total}] ${wallet.slice(0,10)}... Faucet loi: ${err.message}`);
    return 'error';
  }
}

module.exports = { runFaucet };
