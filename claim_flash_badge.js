const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { HttpsCookieAgent } = require('http-cookie-agent/http');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { loadFile, loadJSON, saveJSON, log, now, fmtDate, parseProxy } = require('./modules/utils');

const BASE_URL = 'https://inception.dachain.io';

function buildClient(jar, proxyUrl) {
  const agent = new HttpsProxyAgent(proxyUrl);
  const httpsAgent = new HttpsCookieAgent({ cookies: { jar }, ...agent.options });
  return axios.create({
    httpsAgent,
    httpAgent: httpsAgent,
    headers: {
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'origin': BASE_URL,
      'referer': `${BASE_URL}/`,
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
  await jar.setCookie(`csrftoken=${token}`, BASE_URL);
  const client = buildClient(jar, proxyUrl);

  const res = await client.post(`${BASE_URL}/api/auth/wallet/`, {
    wallet_address: walletAddress,
  }, {
    headers: {
      'content-type': 'application/json',
      'x-csrftoken': token,
      'X-CSRFToken': token,
    },
  });

  const cookies = await jar.getCookies(BASE_URL);
  const sessionid = cookies.find(c => c.key === 'sessionid')?.value;
  const latestCsrf = cookies.find(c => c.key === 'csrftoken')?.value;
  return { ...res.data, sessionid, csrftoken: latestCsrf || token, client, jar };
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
      const details = err.response?.data ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
      log('[RETRY]', `Attempt ${attempt}/${maxRetry} (${proxy.split(':').slice(0, 2).join(':')}) | csrf_len=${String(csrfToken || '').trim().length}: ${details}`);
      if (attempt === maxRetry) throw err;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function claimFlashBadge(client, csrfToken) {
  const res = await client.post('https://inception.dachain.io/api/inception/flash-badge/claim/', null, {
    headers: {
      'content-type': 'application/json',
      'x-csrftoken': csrfToken,
      'referer': 'https://inception.dachain.io/dashboard',
    },
  });
  return res.data;
}

async function main() {
  const force = process.argv.includes('--force');
  const wallets = loadFile('wallets.txt');
  const proxies = loadFile('proxies.txt');
  const sessions = loadJSON('sessions.json');

  if (wallets.length === 0) {
    throw new Error('wallets.txt dang rong');
  }

  if (proxies.length === 0) {
    throw new Error('proxies.txt dang rong');
  }

  let ok = 0;
  let fail = 0;
  let skip = 0;

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const walletKey = wallet.toLowerCase();
    const index = i + 1;
    const saved = sessions[walletKey] || {};

    if (!force && saved.flash_badge_claimed) {
      skip++;
      log('[SKIP]', `[${index}/${wallets.length}] ${wallet.slice(0, 10)}... Flash badge da claim`);
      continue;
    }

    try {
      log('[LOGIN]', `[${index}/${wallets.length}] ${wallet.slice(0, 10)}... Dang nhap`);
      const result = await loginWithRetry(wallet, proxies, saved.csrftoken);

      sessions[walletKey] = {
        ...saved,
        sessionid: result.sessionid,
        csrftoken: result.csrftoken,
      };
      saveJSON('sessions.json', sessions);

      const data = await claimFlashBadge(result.client, result.csrftoken);

      sessions[walletKey] = {
        ...sessions[walletKey],
        flash_badge_claimed: true,
        flash_badge_claimed_at: now(),
        flash_badge_claim_response: data,
      };
      saveJSON('sessions.json', sessions);

      ok++;
      log(
        '[OK]',
        `[${index}/${wallets.length}] ${wallet.slice(0, 10)}... Claim flash badge thanh cong (${fmtDate(sessions[walletKey].flash_badge_claimed_at)})`
      );
    } catch (err) {
      fail++;
      const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      log('[ERR]', `[${index}/${wallets.length}] ${wallet.slice(0, 10)}... Claim that bai: ${details}`);
    }
  }

  log('[DONE]', `Xong | OK: ${ok} | FAIL: ${fail} | SKIP: ${skip} | FORCE: ${force ? 'ON' : 'OFF'}`);
}

main().catch(err => {
  const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  log('[FATAL]', details);
  process.exitCode = 1;
});
