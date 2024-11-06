const fs = require('fs');
const readline = require('readline');
const { Keypair, Connection, clusterApiUrl } = require('@solana/web3.js');
const { derivePath } = require('ed25519-hd-key');
const bip39 = require('bip39');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const chalk = require('chalk');

const BASE_PATH = '/sol-treasure-data';
const SEED_FILE = `${__dirname}/seed-key-words.txt`;
const TRIED_FILE = `${BASE_PATH}/logs.json`;
const FOUND_FILE = `${BASE_PATH}/found.json`;

const numWorkers = process.env.NUM_WORKERS ? parseInt(process.env.NUM_WORKERS) : 8;
let globalRetryDelay = 0;

if (isMainThread) {
  const seeds = fs.readFileSync(SEED_FILE, 'utf8').split('\n');
  let triedSet = new Set();
  let triedWallets = {};
  let walletCounter = 0;
  const workers = [];

  function logInfo(message, workerId = '') {
    console.log(chalk.blue(`[INFO - ${new Date().toISOString()}] ${workerId && `[Worker ${workerId}] `}${message}`));
  }

  function logError(message, workerId = '') {
    console.error(chalk.red(`[ERROR - ${new Date().toISOString()}] ${workerId && `[Worker ${workerId}] `}${message}`));
  }

  function logSuccess(message, workerId = '') {
    console.log(chalk.green(`[SUCCESS - ${new Date().toISOString()}] ${workerId && `[Worker ${workerId}] `}${message}`));
  }

  function loadProgress() {
    if (fs.existsSync(TRIED_FILE) && fs.readFileSync(TRIED_FILE, 'utf8').trim() !== '') {
      const data = JSON.parse(fs.readFileSync(TRIED_FILE, 'utf8'));
      triedWallets = data.triedWallets || {};
      triedSet = new Set(Object.keys(triedWallets));
      walletCounter = data.walletCounter || 0;
      logInfo(`Progress loaded: ${walletCounter} wallets already checked.`);
    } else {
      logInfo('No previous progress detected. Starting from scratch.');
    }
  }

  function saveTriedSet(seedPhrase, pubkey, balance, workerId) {
    walletCounter++;
    triedWallets[walletCounter] = { seedPhrase, pubkey, balance, timestamp: new Date().toISOString() };
    const dataToSave = { triedWallets, walletCounter, lastUpdated: new Date().toISOString() };
    fs.writeFileSync(TRIED_FILE, JSON.stringify(dataToSave, null, 2));
    logInfo(`Tried set saved for wallet #${walletCounter}: pubkey: ${pubkey}, balance: ${balance}`, workerId);
  }

  function saveFoundWallet(pubkey, seed, balance, workerId) {
    const foundData = { pubkey, seed, balance };
    let foundWallets = fs.existsSync(FOUND_FILE) ? JSON.parse(fs.readFileSync(FOUND_FILE, 'utf8')) : [];
    foundWallets.push(foundData);
    fs.writeFileSync(FOUND_FILE, JSON.stringify(foundWallets, null, 2));
    logSuccess(`Wallet with balance found! Public Key: ${pubkey}, Balance: ${balance}. Script will now terminate.`, workerId);
  }

  async function checkInitialization() {
    const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed', { fetchOpts: { timeout: 60000 } });
    try {
      const version = await connection.getVersion();
      logSuccess(`Connection successfully established. Version: ${version['solana-core']}`);
    } catch (error) {
      logError(`Error establishing connection to Solana network: ${error.message}`);
      process.exit(1);
    }
  }

  (async () => {
    await checkInitialization();
    loadProgress();

    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(__filename, { workerData: { seeds, triedSet: Array.from(triedSet), walletCounter, workerId: i + 1 } });
      workers.push(worker);

      worker.on('message', (message) => {
        if (message.type === 'saveTriedSet') {
          saveTriedSet(message.seedPhrase, message.pubkey, message.balance, message.workerId);
        } else if (message.type === 'saveFoundWallet') {
          saveFoundWallet(message.pubkey, message.seedPhrase, message.balance, message.workerId);
          workers.forEach(w => w.terminate());
          process.exit(0);
        } else if (message.type === 'logError') {
          logError(message.error, message.workerId);
        } else if (message.type === 'requestRetryDelay') {
          globalRetryDelay = Math.max(globalRetryDelay, 5000 + Math.floor(Math.random() * 5000));
          worker.postMessage({ type: 'setRetryDelay', delay: globalRetryDelay });
        }
      });

      worker.on('error', (error) => logError(error.message, i + 1));
      worker.on('exit', (code) => {
        if (code !== 0) logError(`Worker ${i + 1} stopped with exit code ${code}`);
      });
    }
  })();
} else {
  const seeds = workerData.seeds;
  const triedSet = new Set(workerData.triedSet);
  const workerId = workerData.workerId;

  let retryDelay = 2000;

  parentPort.on('message', (message) => {
    if (message.type === 'setRetryDelay') {
      retryDelay = message.delay;
    }
  });

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getRandomSeedPhrase(seeds, length) {
    const selectedIndices = new Set();
    while (selectedIndices.size < length) {
      const randomIndex = Math.floor(Math.random() * seeds.length);
      selectedIndices.add(randomIndex);
    }
    return Array.from(selectedIndices).map(index => seeds[index]).join(' ');
  }

  async function checkWallet(seedPhrase) {
    const seed = await bip39.mnemonicToSeed(seedPhrase);
    const derivedSeed = derivePath(`m/44'/501'/0'/0'`, seed.toString('hex')).key;
    const keypair = Keypair.fromSeed(derivedSeed);
    const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
    const pubkey = keypair.publicKey.toBase58();
    try {
      parentPort.postMessage({ type: 'logInfo', message: `Checking wallet with public key: ${pubkey}`, workerId });
      const balance = await connection.getBalance(keypair.publicKey);
      if (balance > 0) {
        parentPort.postMessage({ type: 'saveFoundWallet', pubkey, seedPhrase, balance, workerId });
        process.exit(0);
      }
      parentPort.postMessage({ type: 'saveTriedSet', seedPhrase, pubkey, balance, workerId });
    } catch (error) {
      parentPort.postMessage({ type: 'logError', error: `Error checking seed: ${seedPhrase} -> ${error.message}`, workerId });
      parentPort.postMessage({ type: 'requestRetryDelay' });
      await delay(retryDelay);
    }
  }

  (async () => {
    while (true) {
      const seedPhrase = getRandomSeedPhrase(seeds, 12);
      if (!triedSet.has(seedPhrase)) {
        await checkWallet(seedPhrase);
      }
      await delay(retryDelay);
    }
  })();
}
