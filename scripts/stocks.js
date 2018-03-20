const _ = require('lodash');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const Bluebird = require('bluebird');
const moment = require('moment');

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

const { fetchStockNumbers, analyzeStock, sendStockNumbersToSlack, sendStockToSlack, sendTradingsToSlack,
  fetchTickerStockProfile, fetchLatestTradingDate } = require('../build/stock');
(async () => {
  const [,, ...options] = process.argv;
  const ignoreFilter = options.findIndex(d => d === 'ignore') !== -1;
  const stockNumbers = await fetchStockNumbers();
  const summaries = await Bluebird.mapSeries(
    stockNumbers.filter(d => d !== 'ignore'),
    stockNumber => analyzeStock(+stockNumber, ignoreFilter),
  );
  const potentialStockNumbers = summaries.filter(d => d).map(summary => summary.stockNumber);

  const lastTradingDate = await fetchLatestTradingDate();

  const hourDiff = moment().diff(moment(lastTradingDate).startOf('day'), 'hour');
  if (hourDiff > 17 /* 5pm */ && hourDiff < 32 /* 8am */) {
    const tradingFilePath2 = path.join(__dirname, '..', 'data', `trading${moment(lastTradingDate).format('YYYYMMDD')}.json`);
    if (!fs.existsSync(tradingFilePath2)) {
      const tradingFilePath = path.join(__dirname, '..', 'data', 'trading.json');
      let tradings = {
        balance: 0,
        transactions: [],
        hold: [],
        buy: [],
        sell: [],
      };
      if (fs.existsSync(tradingFilePath)) {
        tradings = JSON.parse(fs.readFileSync(tradingFilePath, { encoding: 'utf8' }));
      }

      // buy transactions
      ///////////////////////////////
      const buyTransactions = await Bluebird.map(
        tradings.buy,
        async stockNumber => ({
          stockNumber,
          date: lastTradingDate,
          type: 'A',
          price: (await fetchTickerStockProfile(stockNumber)).open,
        })
      );
      tradings.hold = [...tradings.hold, ...tradings.buy];
      // sell transactions
      const holdingStocksSummaries = await Bluebird.mapSeries(
        tradings.hold,
        stockNumber => analyzeStock(+stockNumber, true),
      );
      const sellTransactions = await Bluebird.map(
        tradings.sell,
        async stockNumber => ({
          stockNumber,
          date: lastTradingDate,
          type: 'B',
          price: (await fetchTickerStockProfile(stockNumber)).open,
        })
      );
      // update transacitons
      tradings.transactions = _.sortBy([...tradings.transactions, ...buyTransactions, ...sellTransactions], 'date');
      // calculate overview
      const allBuyData = _.reduce(
        tradings.transactions.filter(t => t.type === 'A'),
        (r, buyTrans) => Object.assign(
          r, {
            [buyTrans.stockNumber]: _.sortBy([
              ...(r[buyTrans.stockNumber] || []),
              buyTrans,
            ], 'date'),
          },
        ), {}
      );
      const allSellData = _.reduce(
        tradings.transactions.filter(t => t.type === 'B'),
        (r, sellTrans) => Object.assign(
          r, {
            [sellTrans.stockNumber]: _.sortBy([
              ...(r[sellTrans.stockNumber] || []),
              sellTrans,
            ], 'date'),
          },
        ), {}
      );
      const overview = _.mapValues(allBuyData, (buyData, stockNumber) => {
        let balance = 0;
        buyData.forEach((d, i) => {
          if (allSellData[stockNumber] && allSellData[stockNumber][i]) {
            balance += (allSellData[stockNumber][i].price - d.price) / d.price;
          } else {
            console.log(holdingStocksSummaries.find(s => s.stockNumber === +stockNumber).profile.close);
            balance += (holdingStocksSummaries.find(s => s.stockNumber === +stockNumber).profile.close - d.price) / d.price;
          }
        });
        return balance;
      });
      tradings.balance = _.sum(Object.values(overview));

      tradings.overview = overview;
      // update holding, remove all the sold stock
      tradings.hold = _.remove(tradings.hold, n => tradings.sell.indexOf(n) === -1);
      // buy stocks excluding holding stocks
      const buyStocks = summaries.filter(d => d).filter(s => s.buy).map(s => s.stockNumber);
      tradings.buy = _.remove(buyStocks, n => tradings.hold.indexOf(n) === -1);
      // sell stocks excluding holding stocks
      const sellStocks = holdingStocksSummaries.filter(d => d).filter(s => s.sell).map(s => s.stockNumber);
      tradings.sell = _.remove(sellStocks, n => tradings.hold.indexOf(n) === -1);

      // update tradings
      fs.writeFileSync(tradingFilePath, JSON.stringify(tradings), { encoding:'utf8', flag: 'w' });
      fs.writeFileSync(tradingFilePath2, JSON.stringify(tradings), { encoding:'utf8', flag: 'w' });
      await sendTradingsToSlack(tradings, '#general');
      await sendTradingsToSlack(tradings, '#stock');
    } else {
      const tradings = JSON.parse(fs.readFileSync(tradingFilePath2, { encoding:'utf8' }));
      await sendTradingsToSlack(tradings, '#general');
      await sendTradingsToSlack(tradings, '#stock');  
    }
  }
  await sendStockNumbersToSlack(potentialStockNumbers, '#general');
  await sendStockNumbersToSlack(potentialStockNumbers, '#stock');

  await Bluebird.mapSeries(summaries.filter(d => d), summary => sendStockToSlack(summary, '#stock'));
})();
