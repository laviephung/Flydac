// modules/send.js
// Moi vi trong private.txt gui N tx den N dia chi random khac nhau tu wallets.txt
// Chay song song theo batch, kich hoat qua Telegram /send <so_tx>

const { ethers } = require('ethers');
const { log, loadFile } = require('./utils');

const RPC         = 'https://rpctest.dachain.tech';
const GAS_LIMIT   = 21000;
const AMOUNT      = '0.001'; // so token moi tx, chinh o day neu can
const DELAY_MS    = 1500;    // delay giua cac tx cua 1 vi
const RETRY_LIMIT = 3;
const RETRY_WAIT  = 5000;
const BATCH_SIZE  = 5;       // so vi chay cung luc

let _provider = null;
function getProvider() {
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC);
  return _provider;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadPrivateKeys() {
  return loadFile('private.txt');
}

/** Chon ngau nhien n phan tu KHAC NHAU tu mang arr */
function pickRandom(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
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
      if (attempt < RETRY_LIMIT) await sleep(RETRY_WAIT);
    }
  }
  return { success: false };
}

/**
 * Xu ly 1 vi: gui txCount tx den txCount dia chi random khac nhau
 */
async function processWallet(privateKey, receivers, txCount, walletIndex, totalWallets) {
  const provider = getProvider();
  let wallet;

  try {
    wallet = new ethers.Wallet(privateKey, provider);
  } catch (err) {
    log('[SEND]', `[${walletIndex}/${totalWallets}] Private key khong hop le: ${err.message}`);
    return { address: '(invalid)', success: 0, fail: txCount };
  }

  const targets = pickRandom(receivers, txCount);
  log('[SEND]', `[${walletIndex}/${totalWallets}] ${wallet.address.slice(0, 10)}... bat dau ${targets.length} tx`);

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
  const receivers   = loadFile('wallets.txt').filter(x => {
    try { return ethers.isAddress(x); } catch { return false; }
  });

  if (!privateKeys.length) throw new Error('Khong co private key trong private.txt');
  if (!receivers.length)   throw new Error('Khong co dia chi hop le trong wallets.txt');

  const actualTxCount = Math.min(txCount, receivers.length);

  if (receivers.length < txCount) {
    log('[SEND]', `Canh bao: wallets.txt chi co ${receivers.length} dia chi, moi vi se gui toi da ${actualTxCount} tx`);
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
