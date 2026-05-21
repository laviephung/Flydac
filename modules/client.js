const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { HttpsCookieAgent } = require('http-cookie-agent/http');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { parseProxy, log } = require('./utils');

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

async function getCookieValue(jar, key) {
  const cookies = await jar.getCookies(BASE_URL);
  return cookies.find(c => c.key === key)?.value;
}

async function refreshCsrfToken(client, jar) {
  await client.get(`${BASE_URL}/`, {
    headers: { referer: `${BASE_URL}/`, 'content-type': undefined },
  });

  const csrftoken = await getCookieValue(jar, 'csrftoken');
  if (!csrftoken) {
    throw new Error('Khong lay duoc csrftoken moi');
  }

  return csrftoken;
}

async function doLogin(walletAddress, proxyUrl, csrfToken) {
  const jar = new CookieJar();
  const client = buildClient(jar, proxyUrl);
  let activeCsrf = csrfToken;

  if (activeCsrf) {
    await jar.setCookie(`csrftoken=${activeCsrf}`, BASE_URL);
  }

  activeCsrf = await refreshCsrfToken(client, jar);

  const res = await client.post(`${BASE_URL}/api/auth/wallet/`, {
    wallet_address: walletAddress,
  }, {
    headers: { 'content-type': 'application/json', 'x-csrftoken': activeCsrf },
  });

  const sessionid = await getCookieValue(jar, 'sessionid');
  const latestCsrf = await getCookieValue(jar, 'csrftoken');
  return { ...res.data, sessionid, csrftoken: latestCsrf || activeCsrf, client, jar };
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
      return await doLogin(wallet, parseProxy(proxy), csrfToken);
    } catch (err) {
      log('[RETRY]', `Attempt ${attempt}/${maxRetry} (${proxy.split(':').slice(0, 2).join(':')}): ${err.message}`);
      if (attempt === maxRetry) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

module.exports = { buildClient, loginWithRetry };
