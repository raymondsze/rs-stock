const _ = require('lodash');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Bluebird = require('bluebird');

const NODE_ENV = _.defaultTo(process.env.NODE_ENV, 'development');
process.env.NODE_ENV = NODE_ENV;

const DOT_ENV_PATH = path.join(fs.realpathSync(process.cwd()), '.env');
const dotenvFiles = [
  `${DOT_ENV_PATH}.${NODE_ENV}.local`,
  `${DOT_ENV_PATH}.${NODE_ENV}`,
  // Don't include `.env.local` for `test` environment
  // since normally you expect tests to produce the same
  // results for everyone
  NODE_ENV !== 'test' && `${DOT_ENV_PATH}.local`,
  DOT_ENV_PATH,
].filter(Boolean);

// Load environment variables from .env* files. Suppress warnings using silent
// if this file is missing. dotenv will never modify any environment variables
// that have already been set.
// https://github.com/motdotla/dotenv
dotenvFiles.forEach(dotenvFile => {
  if (fs.existsSync(dotenvFile)) {
    require('dotenv').config({
      path: dotenvFile,
    });
  }
});
// integrate bunyan error logging when uncaught exception
process.on('uncaughtException', (err) => {
  console.error(err);
  process.exit(1);
});

const { fetchStockNumbers } = require('../build/stock');
(async () => {
  const stockNumbers = await fetchStockNumbers();
  // const threads = [[1548]];
  const threads = _.chunk(stockNumbers, Math.round(stockNumbers.length / 3));
  await Bluebird.map(
    threads,
    (thread, i) => new Promise((resolve, reject) => {
      const exec = spawn('node', [path.join(__dirname, 'seedStock.js'), ...thread]);
      exec.stdout.on('data', (data) => {
        console.log(`[Chunk ${i}]: ${data.toString()}`);
      });
      exec.stderr.on('data', (data) => {
        console.error(`[Chunk ${i}]: ${data.toString()}`);
        reject();
      });
      exec.on('exit', (code) => {
        console.log(`[Chunk ${i}]: Seeding ${thread => thread.toString()} is done`);
        resolve();
      });
    }),
  );
})();
