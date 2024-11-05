const fs = require('fs');
const { Keypair, Connection, clusterApiUrl } = require('@solana/web3.js');
const { derivePath } = require('ed25519-hd-key');
const bip39 = require('bip39');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const chalk = require('chalk');

const BASE_PATH = '/sol-treasure-data';

if (isMainThread) {
  global.seeds = fs.readFileSync(`${BASE_PATH}/seed-key-words.txt`, 'utf8').split('\n');
  const triedFile = `${BASE_PATH}/logs.json`;
  let triedSet = new Set();
  let triedWallets = {};
  let walletCounter = 0;

  function logInfo(message) {
    console.log(chalk.blue(`[INFO - ${new Date().toISOString()}] ${message}`));
  }

  function logError(message) {
    console.error(chalk.red(`[ERROR - ${new Date().toISOString()}] ${message}`));
  }

  function logSuccess(message) {
    console.log(chalk.green(`[SUCCESS - ${new Date().toISOString()}] ${message}`));
  }

  function loadProgress() {
    if (fs.existsSync(triedFile) && fs.readFileSync(triedFile, 'utf8').trim() !== '') {
      const data = JSON.parse(fs.readFileSync(triedFile, 'utf8'));
      triedWallets = data.triedWallets || {};
      triedSet = new Set(Object.keys(triedWallets));
      walletCounter = data.walletCounter || 0;
      logInfo(`Progress loaded: ${walletCounter} wallets already checked.`);
    } else {
      logInfo('No previous progress detected. Starting from scratch.');
    }
  }

  function saveTriedSet(seedPhrase, pubkey, balance) {
    walletCounter++;
    triedWallets[walletCounter] = { seedPhrase, pubkey, balance, timestamp: new Date().toISOString() };
    const dataToSave = { triedWallets, walletCounter, lastUpdated: new Date().toISOString() };
    fs.writeFileSync(triedFile, JSON.stringify(dataToSave, null, 2));
    logInfo(`Tried set saved for wallet #${walletCounter}: pubkey: ${pubkey}, balance: ${balance}`);
  }

  function saveFoundWallet(pubkey, seed, balance) {
    const foundFile = `${BASE_PATH}/found.json`;
    const foundData = { pubkey, seed, balance };
    let foundWallets = [];
    if (fs.existsSync(foundFile) && fs.readFileSync(foundFile, 'utf8').trim() !== '') {
      foundWallets = JSON.parse(fs.readFileSync(foundFile, 'utf8'));
    }
    foundWallets.push(foundData);
    fs.writeFileSync(foundFile, JSON.stringify(foundWallets, null, 2));
    logSuccess(`Found wallet added: ${pubkey}, balance: ${balance}`);
  }

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

  async function checkInitialization() {
    logInfo('Checking connection to Solana network...');
    const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed', { fetchOpts: { timeout: 120000 } });
    const version = await connection.getVersion();
    logSuccess(`Connection successfully established. Version: ${version['solana-core']}`);
  }

  (async () => {
    await checkInitialization();
    loadProgress();

    const numWorkers = 1;
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(__filename, { workerData: { seeds: global.seeds, triedSet: Array.from(triedSet), walletCounter, workerId: i + 1 } });
      worker.on('message', (message) => {
        if (message.type === 'saveTriedSet') {
          saveTriedSet(message.seedPhrase, message.pubkey, message.balance);
        } else if (message.type === 'saveFoundWallet') {
          saveFoundWallet(message.pubkey, message.seedPhrase, message.balance);
        }
      });
      worker.on('error', logError);
      worker.on('exit', (code) => {
        if (code !== 0) {
          logError(`Worker ${i + 1} stopped with exit code ${code}`);
        }
      });
    }
  })();
} else {
  const seeds = workerData.seeds;
  const triedSet = new Set(workerData.triedSet);
  const workerId = workerData.workerId;

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
    while (true) {
      try {
        const seed = await bip39.mnemonicToSeed(seedPhrase);
        const derivedSeed = derivePath(`m/44'/501'/0'/0'`, seed.toString('hex')).key;
        const keypair = Keypair.fromSeed(derivedSeed);
        const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
        const pubkey = keypair.publicKey.toBase58();
        console.log(`[Worker ${workerId} - INFO] Testing seed: ${seedPhrase} for pubkey: ${pubkey}`);
        const balance = await connection.getBalance(keypair.publicKey);
        console.log(`[Worker ${workerId} - INFO] Retrieved balance for wallet ${pubkey}: ${balance}`);
        if (balance > 0) {
          console.log(`[Worker ${workerId} - SUCCESS] Found SOL in wallet: ${pubkey} with balance: ${balance}`);
          parentPort.postMessage({ type: 'saveFoundWallet', pubkey, seedPhrase, balance });
          console.log(`[SUCCESS] Wallet found with balance ${balance} SOL. Halting script.`);
          process.exit(0);
        } else {
          console.log(`[Worker ${workerId} - INFO] No SOL found in wallet: ${pubkey}`);
        }
        parentPort.postMessage({ type: 'saveTriedSet', seedPhrase, pubkey, balance });
        break;
      } catch (error) {
        console.error(`[Worker ${workerId} - ERROR] Error checking seed: ${seedPhrase} -> ${error.message}`);
        await delay(5000 + Math.floor(Math.random() * 5000));
      }
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
