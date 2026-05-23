// modules/send.js
// Moi vi trong private.txt gui N tx den N dia chi random khac nhau tu wallets.txt
// Chay song song theo batch, kich hoat qua Telegram /send <so_tx>

const { ethers } = require('ethers');
const { log, loadFile } = require('./utils');

const GAS_LIMIT   = 21000;
const AMOUNT      = '0.001'; // so token moi tx
const DELAY_MS    = Number(process.env.SEND_DELAY_MS || 1500);     // delay giua cac tx cua 1 vi
const RETRY_LIMIT = Number(process.env.SEND_RETRY_LIMIT || 4);
const RETRY_WAIT  = Number(process.env.SEND_RETRY_WAIT_MS || 7000);
const BATCH_SIZE  = Number(process.env.SEND_BATCH_SIZE || 2);      // so vi chay cung luc
const RPC_RETRY_LIMIT = Number(process.env.SEND_RPC_RETRY_LIMIT || 4);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getRpcUrl() {
  return process.env.DAC_RPC_URL || 'https://rpctest.dachain.tech';
}

function getChainId() {
  return Number(process.env.DAC_CHAIN_ID || 21894);
}

function getRetryWait(attempt) {
  return RETRY_WAIT * attempt;
}

function loadPrivateKeys() {
  return loadFile('private.txt');
}

/** Chon ngau nhien n phan tu KHAC NHAU tu mang arr */
function pickRandom(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

function createProvider() {
  const fetchReq = new ethers.FetchRequest(getRpcUrl());
  return new ethers.JsonRpcProvider(fetchReq, getChainId(), { staticNetwork: true });
}

/** Tao provider direct, khong dung proxy */
async function buildProvider() {
  for (let attempt = 1; attempt <= RPC_RETRY_LIMIT; attempt++) {
    const provider = createProvider();
    try {
      await provider.getBlockNumber();
      return provider;
    } catch (err) {
      const msg = err.shortMessage || err.message;
      log('[SEND]', `RPC direct loi (${attempt}/${RPC_RETRY_LIMIT}): ${msg}`);
      if (attempt < RPC_RETRY_LIMIT) {
        const waitMs = getRetryWait(attempt);
        log('[SEND]', `RPC direct doi ${waitMs}ms roi thu lai`);
        await sleep(waitMs);
      }
    }
  }

  throw new Error(`Khong ket noi duoc RPC ${getRpcUrl()} direct sau ${RPC_RETRY_LIMIT} lan thu`);
}

/** Gui 1 tx, khong doi confirm */
async function sendTx(wallet, to) {
  const tx = await wallet.sendTransaction({
    to,
    value: ethers.parseEther(AMOUNT),
    gasLimit: GAS_LIMIT,
  });
  return tx.hash;
}

/** Retry khi loi */
async function sendWithRetry(wallet, to, txIndex, totalTx) {
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      const hash = await sendTx(wallet, to);
      log('[SEND]', `${wallet.address.slice(0, 10)}... tx[${txIndex}/${totalTx}] -> ${to.slice(0, 10)}... | ${hash.slice(0, 16)}...`);
      return { success: true, hash };
    } catch (err) {
      const msg = err.shortMessage || err.message;
      log('[SEND]', `${wallet.address.slice(0, 10)}... tx[${txIndex}/${totalTx}] loi (${attempt}/${RETRY_LIMIT}): ${msg}`);
      if (attempt < RETRY_LIMIT) {
        const waitMs = getRetryWait(attempt);
        log('[SEND]', `${wallet.address.slice(0, 10)}... doi ${waitMs}ms roi thu lai`);
        await sleep(waitMs);
      }
    }
  }
  return { success: false };
}

/**
 * Xu ly 1 vi: gui txCount tx den txCount dia chi random khac nhau
 */
async function processWallet(privateKey, receivers, txCount, walletIndex, totalWallets) {
  let provider;

  try {
    provider = await buildProvider();
  } catch (err) {
    log('[SEND]', `[${walletIndex}/${totalWallets}] Khong tao duoc provider: ${err.message}`);
    return { address: '(rpc-failed)', success: 0, fail: txCount };
  }

  let wallet;
  try {
    wallet = new ethers.Wallet(privateKey, provider);
  } catch (err) {
    log('[SEND]', `[${walletIndex}/${totalWallets}] Private key khong hop le: ${err.message}`);
    return { address: '(invalid)', success: 0, fail: txCount };
  }

  const targets = pickRandom(receivers, txCount);
  log('[SEND]', `[${walletIndex}/${totalWallets}] ${wallet.address.slice(0, 10)}... bat dau ${targets.length} tx | direct RPC`);

  let success = 0;
  let fail    = 0;

  for (let i = 0; i < targets.length; i++) {
    const result = await sendWithRetry(wallet, targets[i], i + 1, targets.length);
    if (result.success) success++;
    else fail++;
    if (i < targets.length - 1) await sleep(DELAY_MS);
  }

  log('[SEND]', `[${walletIndex}/${totalWallets}] ${wallet.address.slice(0, 10)}... xong | OK: ${success} | Fail: ${fail}`);
  return { address: wallet.address, success, fail };
}

/**
 * Ham chinh: chay toan bo private keys, song song theo BATCH_SIZE
 * @param {number}   txCount    - so tx moi vi
 * @param {Function} isStopped  - callback kiem tra shutdown
 */
async function runSend(txCount, isStopped = () => false) {
  const privateKeys = loadPrivateKeys();
  const receivers   = loadFile('walletsend.txt').filter(x => {
    try { return ethers.isAddress(x); } catch { return false; }
  });

  if (!privateKeys.length) throw new Error('Khong co private key trong private.txt');
  if (!receivers.length)   throw new Error('Khong co dia chi hop le trong wallets.txt');

  const actualTxCount = Math.min(txCount, receivers.length);

  if (receivers.length < txCount) {
    log('[SEND]', `Canh bao: wallets.txt chi co ${receivers.length} dia chi, moi vi gui toi da ${actualTxCount} tx`);
  }

  log('[SEND]', `=== BAT DAU SEND ===`);
  log('[SEND]', `Vi gui: ${privateKeys.length} | Dia chi nhan: ${receivers.length} | TX moi vi: ${actualTxCount} | Batch: ${BATCH_SIZE}`);

  const walletResults = [];
  let totalSuccess = 0;
  let totalFail    = 0;

  for (let i = 0; i < privateKeys.length; i += BATCH_SIZE) {
    if (isStopped()) {
      log('[SEND]', 'Dung theo yeu cau shutdown');
      break;
    }

    const batch = privateKeys.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((pk, j) =>
        processWallet(pk, receivers, actualTxCount, i + j + 1, privateKeys.length)
          .catch(err => {
            log('[SEND]', `[${i + j + 1}/${privateKeys.length}] Wallet crash: ${err.message}`);
            return { address: '(crashed)', success: 0, fail: actualTxCount };
          })
      )
    );

    for (const r of batchResults) {
      totalSuccess += r.success;
      totalFail    += r.fail;
      walletResults.push(r);
    }
  }

  log('[SEND]', `=== KET QUA ===`);
  log('[SEND]', `Tong TX thanh cong: ${totalSuccess} | That bai: ${totalFail}`);

  return {
    totalWallets: privateKeys.length,
    txPerWallet:  actualTxCount,
    totalTx:      privateKeys.length * actualTxCount,
    success:      totalSuccess,
    fail:         totalFail,
    walletResults,
  };
}

module.exports = { runSend };
