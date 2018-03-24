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
  const date = options.find(d => d.match(/\d{8}/));
  const stockNumbers = await fetchStockNumbers();

  const lastTradingDate = date != null ? date : await fetchLatestTradingDate();

  const summaries = await Bluebird.mapSeries(
    stockNumbers,
    stockNumber => analyzeStock(+stockNumber, ignoreFilter, moment(lastTradingDate, 'YYYYMMDD').endOf('day')),
  );
  const potentialStockNumbers = summaries.filter(d => d).map(summary => summary.stockNumber);
  console.log(potentialStockNumbers);
  const hourDiff = moment().diff(moment(lastTradingDate).startOf('day'), 'hour');
  if (hourDiff > 17 /* 5pm */ /*&& hourDiff < 32 /* 8am */) {
    const tradingFilePath2 = path.join(__dirname, '..', 'data',
      `trading${moment(lastTradingDate).format('YYYYMMDD')}.json`);
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

      const getProfile = (stockNumber) => JSON.parse(fs.readFileSync(
        path.join(
          __dirname,
          '../data', 
          `${stockNumber.toString().padStart(6, '0')}.HK_pf${moment(lastTradingDate).format('YYYYMMDD')}.json`,
        ),
      ));
      // buy transactions
      ///////////////////////////////
      const buyTransactions = await Bluebird.map(
        tradings.buy,
        async stockNumber => ({
          stockNumber,
          date: lastTradingDate,
          type: 'A',
          price: getProfile(stockNumber).open,
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
          price: getProfile(stockNumber).open,
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
      let balance = 0;
      let margin = 0;
      const overview = _.mapValues(allBuyData, (buyData, stockNumber) => {
        let buySum = 0;
        let closeSum = 0;
        buyData.forEach((d, i) => {
          buySum += d.price;
          // if current balance enough
          if (balance > 0) {
            balance -= 1;
          } else {
            // if current balance is not enough, need borrow money
            margin += 1;
          }
          if (allSellData[stockNumber] && allSellData[stockNumber][i]) {
            // principal + gain
            closeSum += allSellData[stockNumber][i].price;
            balance += 1 + (allSellData[stockNumber][i].price - d.price) / d.price;
          } else {
            closeSum += holdingStocksSummaries.find(s => s.stockNumber === +stockNumber).profile.close;
            balance += 1 + (holdingStocksSummaries.find(s => s.stockNumber === +stockNumber).profile.close - d.price) / d.price;
          }
        });
        return (closeSum - buySum) / buySum;
      });
      tradings.balance = balance - margin;

      tradings.overview = overview;
      // update holding, remove all the sold stock
      tradings.hold = _.remove(tradings.hold, n => tradings.sell.indexOf(n) === -1);
      // buy stocks excluding holding stocks
      const buyStocks = summaries.filter(d => d).filter(s => s.buy).map(s => s.stockNumber);
      tradings.buy = _.remove(buyStocks, n => tradings.hold.indexOf(n) === -1);
      tradings.canBuy = buyStocks;
      // sell stocks excluding holding stocks
      const sellStocks = holdingStocksSummaries.filter(d => d).filter(s => s.sell).map(s => s.stockNumber);
      tradings.sell = _.remove(sellStocks, n => tradings.hold.indexOf(n) !== -1);
      tradings.canSell = sellStocks;

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
