const fs = require('fs');
const { Keypair, Connection, clusterApiUrl } = require('@solana/web3.js');
const { derivePath } = require('ed25519-hd-key');
const bip39 = require('bip39');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const chalk = require('chalk');
const mysql = require('mysql');

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
  let batchData = [];
  const batchSize = 100;
  const flushInterval = 10 * 60 * 1000;

  function flushBatch() {
    if (batchData.length === 0) return;
    const query = `INSERT INTO tried_wallets (seedPhrase, pubkey, balance) VALUES ?`;
    const values = batchData.map(item => [item.seedPhrase, item.pubkey, item.balance]);
    db.query(query, [values], (err, result) => {
      if (err) {
        console.error(`Error saving batch to database: ${err.message}`);
      } else {
        console.log(`Batch of ${batchData.length} records saved successfully.`);
      }
    });
    batchData = [];
  }

  setInterval(flushBatch, flushInterval);

  async function checkInitialization() {
    let attempt = 0;
    const maxAttempts = 5;
    while (attempt < maxAttempts) {
        try {
            const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
            await connection.getVersion();
            console.log('Connection to Solana network successfully established.');
            return connection;  // Retorna a conexão bem-sucedida
        } catch (error) {
            attempt++;
            console.error(`Attempt ${attempt}: Error connecting to Solana network. Retrying in ${attempt * 5} seconds...`, error.message);
            await new Promise(resolve => setTimeout(resolve, attempt * 5000));  // Espera incremental
        }
    }
    throw new Error('Failed to connect to Solana network after several attempts.');
}


  (async () => {
    await checkInitialization();

    const numWorkers = 1;
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
          batchData.push({ seedPhrase, pubkey, balance });
          console.log(`Accumulated data: ${batchData.length} records in batch`);
          if (batchData.length >= batchSize) {
            flushBatch();
          }
        } else if (message.type === 'saveFoundWallet') {
          const { pubkey, seedPhrase, balance } = message;
          const query = `INSERT INTO found_wallets (pubkey, seed, balance) VALUES (?, ?, ?)`;
          db.query(query, [pubkey, seedPhrase, balance], (err, result) => {
            if (err) console.error(`Error saving found wallet to database: ${err.message}`);
            else console.log(`Found wallet saved: pubkey: ${pubkey}, balance: ${balance}`);
          });
        }
      });
      worker.on('error', error => {
        console.error(`Worker ${i + 1} error: ${error.message}`);
      });
      worker.on('exit', code => {
        if (code !== 0) console.error(`Worker ${i + 1} stopped with exit code ${code}`);
      });
    }
  })();
} else {
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
        const balance = await connection.getBalance(keypair.publicKey);
        if (balance > 0) {
          parentPort.postMessage({ type: 'saveFoundWallet', pubkey, seedPhrase, balance });
        } else {
          parentPort.postMessage({ type: 'saveTriedSet', seedPhrase, pubkey, balance });
        }
        break;
      } catch (error) {
        console.error(chalk.red(`[Worker ${workerId} - ERROR] Error checking seed: ${seedPhrase} -> ${error.message}`));
        await delay(5000);
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
