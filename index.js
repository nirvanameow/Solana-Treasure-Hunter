const fs = require('fs');
const { Keypair, Connection, clusterApiUrl } = require('@solana/web3.js');
const { derivePath } = require('ed25519-hd-key');
const bip39 = require('bip39');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const chalk = require('chalk');
const mysql = require('mysql');

// Setup database connection using environment variables
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

db.connect(err => {
  if (err) {
    console.error('Error connecting to the database: ' + err.stack);
    return;
  }
  console.log('Connected to database as id ' + db.threadId);
  ensureTables();
});

// Ensure database tables exist
function ensureTables() {
  const sqlTriedWallets = `CREATE TABLE IF NOT EXISTS tried_wallets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    seedPhrase TEXT,
    pubkey VARCHAR(100),
    balance DECIMAL(18, 6),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`;

  const sqlFoundWallets = `CREATE TABLE IF NOT EXISTS found_wallets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pubkey VARCHAR(100),
    seed TEXT,
    balance DECIMAL(18, 6),
    found_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`;

  db.query(sqlTriedWallets, (err, result) => {
    if (err) throw err;
    console.log("Table 'tried_wallets' ensured.");
  });

  db.query(sqlFoundWallets, (err, result) => {
    if (err) throw err;
    console.log("Table 'found_wallets' ensured.");
  });
}

if (isMainThread) {
  global.seeds = fs.readFileSync('seed-key-words.txt', 'utf8').split('\n');

  function logInfo(message) {
    console.log(chalk.blue(`[INFO - ${new Date().toISOString()}] ${message}`));
  }

  function logError(message) {
    console.error(chalk.red(`[ERROR - ${new Date().toISOString()}] ${message}`));
  }

  function logSuccess(message) {
    console.log(chalk.green(`[SUCCESS - ${new Date().toISOString()}] ${message}`));
  }

  async function checkInitialization() {
    logInfo('Checking connection to Solana network...');
    try {
      const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
      const version = await connection.getVersion();
      logSuccess(`Connection successfully established. Version: ${version['solana-core']}`);
    } catch (error) {
      logError('Error establishing connection to Solana network: ' + error.message);
      process.exit(1);
    }
    logInfo('Initialization successful. Starting main process...');
  }

  (async () => {
    await checkInitialization();

    const numWorkers = 3;
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(__filename, {
        workerData: {
          seeds: global.seeds,
          workerId: i + 1
        }
      });
      worker.on('message', (message) => {
        if (message.type === 'saveTriedSet') {
          const { seedPhrase, pubkey, balance } = message;
          const query = `INSERT INTO tried_wallets (seedPhrase, pubkey, balance) VALUES (?, ?, ?)`;
          db.query(query, [seedPhrase, pubkey, balance], (err, result) => {
            if (err) logError(`Error saving to database: ${err.message}`);
            else logInfo(`Tried wallet saved: pubkey: ${pubkey}, balance: ${balance}`);
          });
        } else if (message.type === 'saveFoundWallet') {
          const { pubkey, seedPhrase, balance } = message;
          const query = `INSERT INTO found_wallets (pubkey, seed, balance) VALUES (?, ?, ?)`;
          db.query(query, [pubkey, seedPhrase, balance], (err, result) => {
            if (err) logError(`Error saving found wallet to database: ${err.message}`);
            else logSuccess(`Found wallet saved: pubkey: ${pubkey}, balance: ${balance}`);
          });
        }
      });
      worker.on('error', (error) => {
        logError(`Worker ${i + 1} error: ${error.message}`);
      });
      worker.on('exit', (code) => {
        if (code !== 0) {
          logError(`Worker ${i + 1} stopped with exit code ${code}`);
        }
      });
    }
  })();
} else {
  const { Keypair, Connection, clusterApiUrl } = require('@solana/web3.js');
  const { derivePath } = require('ed25519-hd-key');
  const bip39 = require('bip39');
  const seeds = workerData.seeds;
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
        console.log(chalk.yellow(`[Worker ${workerId} - INFO] Testing seed: ${seedPhrase} for pubkey: ${pubkey}`));
        const balance = await connection.getBalance(keypair.publicKey);
        console.log(chalk.yellow(`[Worker ${workerId} - INFO] Retrieved balance for wallet ${pubkey}: ${balance}`));
        if (balance > 0) {
          console.log(chalk.green(`[Worker ${workerId} - SUCCESS] Found SOL in wallet: ${pubkey} with balance: ${balance}`));
          parentPort.postMessage({ type: 'saveFoundWallet', pubkey, seedPhrase, balance });
        } else {
          console.log(chalk.yellow(`[Worker ${workerId} - INFO] No SOL found in wallet: ${pubkey}`));
        }
        parentPort.postMessage({ type: 'saveTriedSet', seedPhrase, pubkey, balance });
        break;
      } catch (error) {
        console.error(chalk.red(`[Worker ${workerId} - ERROR] Error checking seed: ${seedPhrase} -> ${error.message}`));
        await delay(5000 + Math.floor(Math.random() * 5000));
      }
    }
  }

  (async () => {
    while (true) {
      const seedPhrase = getRandomSeedPhrase(seeds, 12);
      await checkWallet(seedPhrase);
      await delay(2000);
    }
  })();
}
