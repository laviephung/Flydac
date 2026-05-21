const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { HttpsCookieAgent } = require('http-cookie-agent/http');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { now, fmtDate, fmtTime, log, saveJSON, saveState } = require('./utils');
const { parseProxy } = require('./utils');
const CRATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 tieng
const CRATE_RETRY_INTERVAL_MS = 10 * 60 * 1000; // 10 phut neu con sot box
const CONCURRENCY = 3; // 3-5 vi cung luc, chinh tuy y

function getHttpErrorDetail(err) {
  const status = err.response?.status;
  const data = err.response?.data;
  if (!status) return err.message;
  const body = data ? ` | body: ${JSON.stringify(data)}` : '';
  return `HTTP ${status}${body}`;
}

function isAuthError(err) {
  const status = err.response?.status;
  return status === 401 || status === 403;
}

async function getCrateHistory(client) {
  return client.get('https://inception.dachain.io/api/inception/crate/history/', {
    headers: { 'referer': 'https://inception.dachain.io/quantum-crate', 'content-type': undefined },
  });
}

function buildClient(jar, proxyUrl) {
  const agent = new HttpsProxyAgent(proxyUrl);
  const httpsAgent = new HttpsCookieAgent({ cookies: { jar }, ...agent.options });
  return axios.create({
    httpsAgent,
    httpAgent: httpsAgent,
    headers: {
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'origin': 'https://inception.dachain.io',
      'referer': 'https://inception.dachain.io/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'dnt': '1',
      'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
  });
}

async function login(walletAddress, proxyUrl, csrfToken) {
  const token = String(csrfToken || '').trim();
  if (token.length !== 32) {
    throw new Error(`csrftoken khong hop le (len=${token.length})`);
  }

  const jar = new CookieJar();
  await jar.setCookie(`csrftoken=${token}`, 'https://inception.dachain.io');
  const client = buildClient(jar, proxyUrl);
  client.defaults.headers.common['x-csrftoken'] = token;
  client.defaults.headers.common['X-CSRFToken'] = token;

  const res = await client.post('https://inception.dachain.io/api/auth/wallet/', {
    wallet_address: walletAddress,
  }, {
    headers: {
      'content-type': 'application/json',
      'x-csrftoken': token,
      'X-CSRFToken': token,
    },
  });

  const cookies = await jar.getCookies('https://inception.dachain.io');
  const sessionid = cookies.find(c => c.key === 'sessionid')?.value;

  return { ...res.data, sessionid, client, jar };
}

async function loginWithRetry(wallet, proxies, csrfToken, maxRetry = 3) {
  const used = new Set();
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    let proxy;
    do {
      proxy = proxies[Math.floor(Math.random() * proxies.length)];
    } while (used.has(proxy) && used.size < proxies.length);
    used.add(proxy);

    try {
      return await login(wallet, parseProxy(proxy), csrfToken);
    } catch (err) {
      log('[RETRY]', `Attempt ${attempt}/${maxRetry} (${proxy.split(':').slice(0, 2).join(':')}) | csrf_len=${String(csrfToken || '').trim().length}: ${getHttpErrorDetail(err)}`);
      if (attempt === maxRetry) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function openCrates(wallet, index, total, proxies, sessions, state, firstRun) {
  const saved = sessions[wallet];
  const ws = state[wallet] || {};
  let stateDirty = false;

  // --- Buoc 1: Check local truoc, 0 request ---
  const lastOpenedAt = ws.last_crate_opened_at || 0;
  const elapsed = now() - lastOpenedAt;
  const retryAt = ws.last_crate_retry_at || 0;
  const retryElapsed = now() - retryAt;

  if (ws.crate_incomplete && retryAt > 0 && retryElapsed < CRATE_RETRY_INTERVAL_MS) {
    log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Crate retry-skip | con: ${fmtTime(CRATE_RETRY_INTERVAL_MS - retryElapsed)}`);
    return 'skipped';
  }

  if (!ws.crate_incomplete && lastOpenedAt > 0 && elapsed < CRATE_INTERVAL_MS) {
    log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Crate skip | lan cuoi: ${fmtDate(lastOpenedAt)} | con: ${fmtTime(CRATE_INTERVAL_MS - elapsed)}`);
    return 'skipped';
  }

  try {
    // --- Buoc 2: Login + GET history ---
    log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Crate login...`);
    let result = await loginWithRetry(wallet, proxies, saved.csrftoken);
    sessions[wallet].sessionid = result.sessionid;
    saveJSON('sessions.json', sessions);

    let history;
    try {
      history = await getCrateHistory(result.client);
    } catch (err) {
      log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... History loi: ${getHttpErrorDetail(err)}`);
      throw err;
    }

    const h = history.data;
    const openedToday = h.opens_today || 0;
    const limit       = h.daily_open_limit || 5;
    const costPerOpen = h.cost_per_open || 150;

    // Lay opened_at tu server, luon cap nhat vao state
    const serverOpenedAt = h.history?.[0]?.opened_at || null;
    const serverOpenedMs = serverOpenedAt ? new Date(serverOpenedAt).getTime() : 0;

    if (serverOpenedMs > 0) {
      ws.last_crate_opened_at = serverOpenedMs;
      state[wallet] = ws;
      stateDirty = true;
    }

    // --- Buoc 3: Double-check voi server time ---
    const serverElapsed = now() - serverOpenedMs;
    if (serverOpenedMs > 0 && serverElapsed < CRATE_INTERVAL_MS) {
      ws.crate_incomplete = false;
      delete ws.last_crate_retry_at;
      if (stateDirty) saveState(wallet, ws);
      log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Crate skip (server) | lan cuoi: ${fmtDate(serverOpenedMs)} | con: ${fmtTime(CRATE_INTERVAL_MS - serverElapsed)}`);
      return 'skipped';
    }

    // --- Buoc 4: Kiem tra con luot khong ---
    const remaining = limit - openedToday;
      log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Da mo: ${openedToday}/${limit} | QE hom nay: ${h.qe_today}`);

    if (remaining <= 0) {
      ws.crate_incomplete = false;
      delete ws.last_crate_retry_at;
      if (stateDirty) saveState(wallet, ws);
      log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Da mo du hom nay`);
      return 'skipped';
    }

    // --- Buoc 5: Random delay 8-15s truoc khi mo hop dau tien ---
    const delay = 8000 + Math.random() * 7000;
    log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Cho ${(delay/1000).toFixed(1)}s truoc khi mo...`);
    await new Promise(r => setTimeout(r, delay));

    // --- Buoc 6: Mo hop ---
    let qeEarned = 0;
    let openedCount = 0;
    for (let i = 0; i < remaining; i++) {
      let res;
      try {
        res = await result.client.post('https://inception.dachain.io/api/inception/crate/open/', null, {
          headers: {
            'content-type': 'application/json',
            'x-csrftoken': saved.csrftoken,
            'referer': 'https://inception.dachain.io/quantum-crate',
          },
        });
      } catch (err) {
        if (isAuthError(err)) {
          log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Open loi box ${openedToday + i + 1}/${limit}, login lai... ${getHttpErrorDetail(err)}`);
          result = await loginWithRetry(wallet, proxies, saved.csrftoken);
          sessions[wallet].sessionid = result.sessionid;
          saveJSON('sessions.json', sessions);
          try {
            res = await result.client.post('https://inception.dachain.io/api/inception/crate/open/', null, {
              headers: {
                'content-type': 'application/json',
                'x-csrftoken': saved.csrftoken,
                'referer': 'https://inception.dachain.io/quantum-crate',
              },
            });
          } catch (retryErr) {
            log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Open retry loi box ${openedToday + i + 1}/${limit}: ${getHttpErrorDetail(retryErr)}`);
            throw retryErr;
          }
        } else {
          log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Open loi box ${openedToday + i + 1}/${limit}: ${getHttpErrorDetail(err)}`);
          throw err;
        }
      }

      const r = res.data.reward;
      qeEarned += r.amount || 0;
      openedCount++;
      log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Hop ${openedToday + i + 1}/${limit} | ${r.label} | QE: ${res.data.inception_qe}`);

      // Luu opened_at moi nhat sau moi lan mo
      const newOpenedAt = res.data.opened_at || now();
      ws.last_crate_opened_at = typeof newOpenedAt === 'string'
        ? new Date(newOpenedAt).getTime()
        : newOpenedAt;
      ws.last_qe_earned = qeEarned;
      state[wallet] = ws;
      stateDirty = true;

      if (res.data.inception_qe < costPerOpen) {
        log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... QE khong du, dung`);
        break;
      }

      // Delay 10-15s giua cac hop (tru hop cuoi)
      if (i < remaining - 1) {
        await new Promise(r => setTimeout(r, 10000 + Math.random() * 5000));
      }
    }

    let finalRemaining = 0;
    try {
      const finalHistory = await getCrateHistory(result.client);
      finalRemaining = Math.max(0, (finalHistory.data.daily_open_limit || 5) - (finalHistory.data.opens_today || 0));
    } catch (err) {
      log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Check lai history loi: ${getHttpErrorDetail(err)}`);
      finalRemaining = Math.max(0, remaining - openedCount);
    }

    if (finalRemaining > 0) {
      ws.crate_incomplete = true;
      ws.last_crate_retry_at = now();
      state[wallet] = ws;
      stateDirty = true;
      if (stateDirty) saveState(wallet, ws);
      log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Con sot ${finalRemaining} box, se thu lai sau ${fmtTime(CRATE_RETRY_INTERVAL_MS)}`);
      return 'success';
    }

    ws.crate_incomplete = false;
    delete ws.last_crate_retry_at;
    state[wallet] = ws;
    stateDirty = true;

    // --- Buoc 7: Ghi first_crate ---
    if (!firstRun[wallet]) firstRun[wallet] = {};
    if (!firstRun[wallet].first_crate) {
      firstRun[wallet].first_crate = ws.last_crate_opened_at;
      log('[MARK]', `[${index}/${total}] ${wallet.slice(0,10)}... First crate: ${fmtDate(firstRun[wallet].first_crate)}`);
      saveJSON('first_run.json', firstRun);
    }

    if (stateDirty) saveState(wallet, ws);
    log('[OK]', `[${index}/${total}] ${wallet.slice(0,10)}... Crate xong | QE kiem duoc: ${qeEarned}`);
    return 'success';

  } catch (err) {
    if (stateDirty) saveState(wallet, ws);
    log('[CRATE]', `[${index}/${total}] ${wallet.slice(0,10)}... Crate loi: ${err.message}`);
    return 'error';
  }
}

async function runCrateLoop(wallets, proxies, sessions, state, firstRun) {
  const stats = { total: wallets.length, success: 0, error: 0, skipped: 0 };

  // Chay CONCURRENCY vi cung luc, xong batch nay moi chay batch tiep
  for (let i = 0; i < wallets.length; i += CONCURRENCY) {
    const batch = wallets.slice(i, i + CONCURRENCY);

    const results = await Promise.all(batch.map(async (w, j) => {
      const wallet = w.toLowerCase();
      if (!sessions[wallet]) return 'skipped';
      if (!state[wallet]) state[wallet] = {};
      return openCrates(wallet, i + j + 1, wallets.length, proxies, sessions, state, firstRun);
    }));

    for (const status of results) {
      if (status === 'success') stats.success++;
      else if (status === 'error') stats.error++;
      else stats.skipped++;
    }
  }

  return stats;
}

module.exports = { runCrateLoop };
