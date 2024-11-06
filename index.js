const fs = require('fs');
const { Keypair, Connection } = require('@solana/web3.js');
const { derivePath } = require('ed25519-hd-key');
const bip39 = require('bip39');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const chalk = require('chalk');

const BASE_PATH = '/sol-treasure-data';
const SEED_FILE = `${__dirname}/seed-key-words.txt`;
const TRIED_FILE = `${BASE_PATH}/logs.json`;
const FOUND_FILE = `${BASE_PATH}/found.json`;

// URLs de RPC
const RPC_URLS = [
  'https://api.mainnet-beta.solana.com'
];

if (isMainThread) {
  global.seeds = fs.readFileSync(SEED_FILE, 'utf8').split('\n');
  let triedSet = new Set();
  let triedWallets = {};
  let walletCounter = 0;
  const workers = [];

  function logInfo(message) {
    console.log(chalk.blue(`[INFO - ${new Date().toISOString()}] ${message}`));
  }

  function logError(message) {
    console.error(chalk.red(`[ERROR - ${new Date().toISOString()}] ${message}`));
  }

  function logSuccess(message) {
    console.log(chalk.green(`[SUCCESS - ${new Date().toISOString()}] ${message}`));
  }

  function checkFoundData() {
    if (fs.existsSync(FOUND_FILE)) {
      const foundData = JSON.parse(fs.readFileSync(FOUND_FILE, 'utf8'));
      if (foundData.length > 0) {
        console.log(chalk.bgYellow.black(`[ALERT] Found wallets already exist. Found ${foundData.length} wallets with balances. Script will not proceed.`));
        process.exit(0);
      }
    }
  }

  (async () => {
    checkFoundData();  // Check if there are any found wallets before starting any work.
    await Promise.all(RPC_URLS.map(url => checkInitialization(url)));
    loadProgress();

    const numWorkers = 5;
    for (let i = 0; i < numWorkers; i++) {
      const rpcUrl = RPC_URLS[i % RPC_URLS.length];
      const worker = new Worker(__filename, { workerData: { seeds: global.seeds, triedSet: Array.from(triedSet), walletCounter, workerId: i + 1, rpcUrl } });
      workers.push(worker);

      worker.on('message', (message) => {
        if (message.type === 'saveTriedSet') {
          saveTriedSet(message.seedPhrase, message.pubkey, message.balance);
        } else if (message.type === 'saveFoundWallet') {
          saveFoundWallet(message.pubkey, message.seedPhrase, message.balance);
          workers.forEach(w => w.terminate());
          process.exit(0);
        }
      });

      worker.on('error', logError);
      worker.on('exit', (code) => {
        if (code !== 0) logError(`Worker ${i + 1} stopped with exit code ${code}`);
      });
    }
  })();
} else {
  const seeds = workerData.seeds;
  const triedSet = new Set(workerData.triedSet);
  const workerId = workerData.workerId;
  const rpcUrl = workerData.rpcUrl;

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
    const connection = new Connection(rpcUrl, 'confirmed');
    const pubkey = keypair.publicKey.toBase58();
    try {
      const balance = await connection.getBalance(keypair.publicKey);
      console.log(`[Worker ${workerId}] Using RPC URL: ${rpcUrl}`);
      if (balance > 0) {
        parentPort.postMessage({ type: 'saveFoundWallet', pubkey, seedPhrase, balance });
        process.exit(0);
      }
      parentPort.postMessage({ type: 'saveTriedSet', seedPhrase, pubkey, balance });
    } catch (error) {
      console.error(`[Worker ${workerId} - ERROR] Error checking seed: ${seedPhrase} -> ${error.message}`);
      await delay(5000 + Math.floor(Math.random() * 5000));
    }
  }

  (async () => {
    while (true) {
      const seedPhrase = getRandomSeedPhrase(seeds, 12);
      if (!triedSet.has(seedPhrase)) {
        await checkWallet(seedPhrase);
      }
      await delay(2000);
    }
  })();
}
