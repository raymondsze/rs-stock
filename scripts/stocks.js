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

const { fetchStockNumbers, analyzeStock, sendStockNumbersToSlack, sendStockToSlack } = require('../build/stock');
(async () => {
  const [,, ...options] = process.argv;
  const ignoreFilter = options.findIndex(d => d === 'ignore') !== -1;
  const stockNumbers = await fetchStockNumbers();
  // const stockNumbers = [
  //   8, 19, 217, 335, 436, 659,
  //   678, 709, 887, 1009, 1068, 1387,
  //   1483, 1579, 1681, 1727, 1778, 1862,
  //   1966, 2083, 3300, 3708,
  // ];
  const summaries = await Bluebird.mapSeries(
    stockNumbers.filter(d => d !== 'ignore'),
    stockNumber => analyzeStock(+stockNumber, ignoreFilter),
  );
  const potentialStockNumbers = summaries.filter(d => d).map(summary => summary.stockNumber);
  await sendStockNumbersToSlack(potentialStockNumbers, '#general');
  await sendStockNumbersToSlack(potentialStockNumbers, '#stock');
  await Bluebird.mapSeries(summaries.filter(d => d), summary => sendStockToSlack(summary, '#stock'));
})();
