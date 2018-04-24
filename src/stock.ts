import * as qs from 'qs';
import * as path from 'path';
import * as fs from 'fs-extra';
import axios /*, { AxiosResponse }*/ from 'axios';
import * as cheerio from 'cheerio';
import * as moment from 'moment';
import * as Slack from 'slack-node';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
// const glob = require("glob");
const format = require('format-number')(({ truncate: 2 }));

/* tslint:disable */
axios.interceptors.response.use(
  undefined as any,
  function axiosRetryInterceptor(err: any) {
    var config = err.config;

    // add retry mechanism
    config.retry = 100;
    config.retryDelay = 2000;

    // If config does not exist or the retry option is not set, reject
    if (!config || !config.retry) return Bluebird.reject(err);

    // Set the variable for keeping track of the retry count
    config.__retryCount = config.__retryCount || 0;

    // Check if we've maxed out the total number of retries
    if (config.__retryCount >= config.retry) {
      // Reject with the error
      return Bluebird.reject(err);
    }

    // Increase the retry count
    config.__retryCount += 1;

    // Create new promise to handle exponential backoff
    var backoff = new Bluebird(function(resolve) {
      setTimeout(function() {
        resolve();
      }, config.retryDelay || 1);
    });

    // Return the promise in which recalls axios to retry the request
    return backoff.then(function() {
      return axios(config);
    });
  },
);

function getTradingVolume(candles: AASDetailTradingData[]) {
  return _.sumBy(candles, d => d.volume);
}

function getTradingCount(candles: AASDetailTradingData[]) {
  return candles.length;
}

function getActiveRate(candles: AASDetailTradingData[]) {
  const candlesInMin = convertAATradingDataToCandles(candles, 'minute');
  const start = moment('201801010900', 'YYYYMMDDHHmm');
  const end = moment('201801011600', 'YYYYMMDDHHmm');
  const minuteDiff = end.diff(start, 'minute');
  return candlesInMin.length / minuteDiff;
}

function isAbnormalVolume(candles: Candle[]) {
  if (candles.length < 2) {
    throw new Error('At least 2 candles to calculate the volume difference');
  }
  const lastDayData = (candles[candles.length - 1].buyVolume || 0) - (candles[candles.length - 1].sellVolume || 0);
  const prevData = _.take(candles, candles.length - 1);
  const avgVol = _.meanBy(prevData.map(d => (d.buyVolume || 0 - d.sellVolume || 0)));
  return Math.abs(lastDayData) >= 1.5 * Math.abs(avgVol);
}

function getTradingPriceRatio(candle: Candle) {
  const priceRange = +candle.high - +candle.low;
  const tradingPriceRange = +candle.close - +candle.open;
  const ratio = tradingPriceRange / priceRange;
  // if ratio >= 0.4 = 大陽燭
  // if ratio <= -0.4 = 大陰燭
  // if positive = 陽燭
  // if negative = 陰燭
  return Number.isNaN(ratio) ? 0 : ratio;
}

// // 陽燭
function isPositiveCandle(candle: Candle) {
  return getTradingPriceRatio(candle) > 0;
}

// // 大陽燭
function isBigPositiveCandle(
  candle: Candle,
  bigCandleThreshold: number,
) {
  return isPositiveCandle(candle) && (
    Math.abs(candle.close - candle.open) > bigCandleThreshold
  );
}

// // 陰燭
function isNegativeCandle(candle: Candle) {
  return candle.close - candle.open < 0;
}

// // 大陰燭
function isBigNegativeCandle(
  candle: Candle,
  bigCandleThreshold: number,
) {
  return isNegativeCandle(candle) && (
    Math.abs(candle.close - candle.open) > bigCandleThreshold
  );
}

// // 十字星
function isCrossStar(candle: Candle, bigCandleThreshold: number) {
  const ratio = getTradingPriceRatio(candle);
  if (
    Math.abs(candle.high - candle.low) > bigCandleThreshold &&
    ratio <= 0.1
  ) {
    const nominator = candle.high - Math.max(candle.close, candle.open);
    const denominator = Math.max(candle.close, candle.open) - candle.low;
    if (nominator / denominator > 0.6 && nominator / denominator < 1.4) {
      return true;
    }
  }
  return false;
}

// // 三白兵
function isSanbaibing(
  targetData: Candle,
  yData: Candle,
  dbyData: Candle,
  ddbyData: Candle,
  bigCandleThreshold: number,
) {
  if (
    isPositiveCandle(targetData) && !isCrossStar(targetData, bigCandleThreshold) &&
    isPositiveCandle(yData) && !isCrossStar(yData, bigCandleThreshold) && 
    isPositiveCandle(dbyData) && !isCrossStar(dbyData, bigCandleThreshold)
  ) {
    return true;
  }
  return false;
}

// // 雙白兵
function isDuobaibing(
  targetData: Candle,
  yData: Candle,
  dbyData: Candle,
  bigCandleThreshold: number,
) {
  if (
    isPositiveCandle(targetData) && !isCrossStar(targetData, bigCandleThreshold) &&
    isPositiveCandle(yData) && !isCrossStar(yData, bigCandleThreshold)
  ) {
    return true;
  }
  return false;
}

// // 跳價高買
function isJumpyBuy(
  targetData: Candle,
  yData: Candle,
  jumpyThreshold: number,
) {
  // if increasing trend
  if (
    Math.min(targetData.close, targetData.open) >
    Math.max(yData.close, yData.open) * (1 + jumpyThreshold)
  ) {
    return true;
  }
  return false;
}

// // 三黑兵
function isSanhaibing(
  targetData: Candle,
  yData: Candle,
  dbyData: Candle,
  ddbyData: Candle,
  bigCandleThreshold: number,
) {
  if (
    isNegativeCandle(targetData) && !isCrossStar(targetData, bigCandleThreshold) &&
    isNegativeCandle(yData) && !isCrossStar(yData, bigCandleThreshold) && 
    isNegativeCandle(dbyData) && !isCrossStar(dbyData, bigCandleThreshold)
  ) {
    return true;
  }
// }
  return false;
}

// // 雙黑兵
function isDuohaibing(
  targetData: Candle,
  yData: Candle,
  dbyData: Candle,
  bigCandleThreshold: number,
) {
  // if increasing trend
  if (targetData.close < yData.close && yData.close < dbyData.close) {
    if (
      isNegativeCandle(targetData) && !isCrossStar(targetData, bigCandleThreshold) &&
      isNegativeCandle(yData) && !isCrossStar(yData, bigCandleThreshold)
    ) {
      return true;
    }
  }
  return false;
}

async function fetchTickerStockName(stockNumber: number): Promise<string> {
  const stockId = stockNumber.toString().padStart(4, '0');
  const { data } = await axios({
    method: 'get',
    url: 'https://api.ticker.com.hk/api/asset/assetbykeyword/'
     + `${stockId}.HK/?filter=stock&filter=index`,
  });
  const assets = data.data;
  return assets[0].localized_full_name.tc;
}

export async function fetchTickerStockProfile(stockId: number): Promise<TickerStockProfile> {
  const { data } = await axios({
    method: 'get',
    url: `https://quote.ticker.com.hk/api/quote/detail/${stockId}.HK`,
  });
  const profile = (data[0] != null) ? data[0] : {};
  return {
    name: profile['name'],
    pe: +profile['PE'],
    open: +profile['Open'],
    close: +profile['lastClosePrice'] + +profile['ChangePrice'],
    high: +profile['High'],
    low: +profile['Low'],
    volume: +profile['Vol'],
    mktCap: +profile['MktCap'],
    changePrice: +profile['ChangePrice'],
    changePercent: +profile['ChangePercent'].substring(0, profile['ChangePercent'].length - 1),
  };
}

interface TickerStockProfile {
  name: string;
  pe: number;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  mktCap: number;
  changePrice: number;
  changePercent: number;
}

// interface AASTradingData {
//   type: string;
//   date: Date;
//   volume: number;
//   auto: boolean;
//   price: number;
//   category: 'ubbull' | 'bbull' | 'rbull' | 'rbear' | 'bbear' | 'ubbear';
// }

interface AASDetailTradingData {
  type: string;
  date: Date;
  label: string;
  volume: number;
  price: number;
}

interface AASCandle {
  date: Date;
  close: number;
  open: number;
  normVolume: number;
  buyVolume: number;
  sellVolume: number;
}

interface SinaCandle {
  date: Date;
  close: number;
  high: number;
  low: number;
  open: number;
  volume: number;
}

interface Candle extends AASCandle, SinaCandle {}

async function fetchSinaStockSeasonData(
  stockId: number,
  year: number,
  season: number,
): Promise<{ [index: string]: SinaCandle }> {
  const res = await axios({
    method: 'post',
    url:
      'http://stock.finance.sina.com.cn/hkstock/history/' +
      `${stockId.toString().padStart(5, '0')}.html`,
    headers: {
      Accept: 'application/x-www-form-urlencoded',
    },
    data: qs.stringify({ year, season }),
  });
  // add some delay to prevent ban
  // .then(res => new Promise<AxiosResponse>(resolve => setTimeout(() => resolve(res), 500)));
  const domData = res.data;
  // date, close, change, change_percent, volume, volume_price, open, highest, lowest, amp
  const columnRefs = [
    'date',
    'close',
    'change',
    'change_percent',
    'volume',
    'volume_price',
    'open',
    'highest',
    'lowest',
    'amp',
  ];
  const numberParser = (value: string) => +value;
  const parsers = {
    date: (value: string) => moment(value, 'YYYYMMDD'),
    volume: numberParser,
    volume_price: numberParser,
    change: numberParser,
    change_percent: numberParser,
    close: numberParser,
    open: numberParser,
    highest: numberParser,
    lowest: numberParser,
    amp: numberParser,
  };
  const $ = cheerio.load(domData);
  return $('tr')
    .toArray()
    .reverse()
    .reduce(
      (result, row, index) => {
        const columns = $(row)
          .find('td')
          .toArray();
        const dailyData = columns.reduce(
          (innerResult, col, i) =>
            columnRefs.length > i ? {
              ...innerResult,
              [columnRefs[i]]: parsers[columnRefs[i]]($(col).text().trim()),
            } : innerResult,
          {},
        ) as any;
        const date = moment(moment(dailyData.date).toISOString());
        if (!date.isValid()) return result;
        return {
          ...result,
          [date.toISOString()]: {
            date: moment(dailyData.date).toDate(),
            volume: dailyData.volume,
            open: dailyData.open,
            close: dailyData.close,
            high: dailyData.highest,
            low: dailyData.lowest,
          } as SinaCandle,
        };
      },
      {} as { [index: string]: SinaCandle },
    );
}

async function fetchSinaCandles(
  stockId: number,
): Promise<SinaCandle[]> {
  const trials = 0;

  const getDataFromSina = async (trials: number): Promise<SinaCandle[]> => {
    if (trials > 5) {
      return [];
    }
    const seasons = [1, 2, 3, 4];
    const years: { year: number; season: number }[] = Array(2)
      .fill(0)
      .reduce(
        (result, _, index) => [
          ...result,
          ...seasons.map(season => ({
            season,
            year: moment().year() - 1 + index,
          })),
        ],
        [],
      );
    const data = Object.values(await Bluebird.all(
      years.map(year => fetchSinaStockSeasonData(stockId, year.year, year.season)),
    )).reduce(
      (result, d) => ([
        ...result,
        ...Object.values(d),
      ]),
      [] as SinaCandle[],
    );
    return data;
  };
  return getDataFromSina(trials + 1);
}

export async function fetchLatestTradingDate(): Promise<Date> {
  const trials = 0;

  const getDataFromAAStock = async (trials: number): Promise<Date> => {
    if (trials > 5) {
      throw new Error('Unable to fetch latest trading date from AAStock');
    }
    // first visit to aastock page to obtain the csrf token
    const { data } = await axios({
      method: 'get',
      url:
        'http://www.aastocks.com/tc/resources/datafeed/getstockindex.ashx?type=5',
    });
    // if error, retry getting data from aastock
    if (data === '-1') {
      return getDataFromAAStock(trials + 1);
    }
    return moment(
      _.get(data.find((d: any) => d.symbol === 'HSI'), 'lastupdate'),
      'YYYY/MM/DD HH:mm',
    ).toDate();
  };

  return getDataFromAAStock(trials + 1);
}

function mapArrayToObject(
  candles: { date: Date }[],
): { [index: string]: { date: Date } } {
  return _.mapValues(
    _.groupBy(candles, candle =>
      moment(candle.date).toISOString(),
    ),
    d => d[0],
  );
};

function mergeSinaNAASCandles(
  aasCandles: AASCandle[],
  tickerCandles: SinaCandle[],
): Candle[] {
  const aas = _.mapValues(
    _.groupBy(aasCandles, aasCandle =>
      moment(aasCandle.date).toISOString(),
    ),
    d => d[0],
  );
  const tickers = _.mapValues(
    _.groupBy(tickerCandles, tickerCandle =>
      moment(tickerCandle.date).toISOString(),
    ),
    d => d[0],
  );
  return _.sortBy(
    Object.values(_.merge(aas as any, tickers as any, aas as any)),
    'date',
  ) as Candle[];
}

function convertAATradingDataToCandles(
  tradingData: AASDetailTradingData[],
  dividend: 'minute' | 'day',
): AASCandle[] {
  const data = _.groupBy(
    tradingData,
    d => moment(d.date).startOf(dividend).toISOString(),
  );
  return _.sortBy(
    Object.values(_.mapValues(data, (d: AASDetailTradingData[], date: string) => {
      const highestPriceData = _.maxBy(d, 'price') as AASDetailTradingData;
      const lowestPriceData = _.minBy(d, 'price') as AASDetailTradingData;
      const totalBuyVolume = _.sumBy(d.filter(d => d.type === 'A'), d => d.volume);
      const totalSellVolume = _.sumBy(d.filter(d => d.type === 'B'), d => d.volume);
      return {
        date: moment(date).toDate(),
        close: (totalBuyVolume > totalSellVolume) ? highestPriceData.price : lowestPriceData.price,
        open: (totalBuyVolume > totalSellVolume) ? lowestPriceData.price : highestPriceData.price,
        normVolume: totalBuyVolume + totalSellVolume,
        buyVolume: totalBuyVolume,
        sellVolume: totalSellVolume,
      };
    })),
    'date',
  );
}

// async function fetchAASTradingDataSet(
//   stockId: number,
//   type: 'ubbull' | 'bbull' | 'rbull' | 'ubbear' | 'bbear' | 'rbear',
//   date: Date,
// ): Promise<AASTradingData[]> {
//   const trials = 0;
//   const getDataFromAAStock = async (trials: number): Promise<AASTradingData[]> => {
//     if (trials > 5) {
//       throw new Error('Unable to fetch latest trading transactions from AAStock');
//     }
//     const { data } = await axios({
//       method: 'get',
//       url: `http://wdata.aastocks.com/datafeed/getultrablocktradelog.ashx?` +
//         qs.stringify({
//           type,
//           symbol: stockId.toString().padStart(6, '0'),
//           lang: 'en',
//           dt: moment(date).format('YYYYMMDD'),
//           f: 1,
//         }),
//     });
//     // if error, retry getting data from aastock
//     if (data === '-1') {
//       return getDataFromAAStock(trials + 1);
//     }
//     const { tslog: tradingData } = data;
//     return tradingData.map(
//       (data: any) => ({
//         type: type.endsWith('bull') ? 'A' : 'B',
//         date: moment(moment(date).format('YYYYMMDD') + data.dt, 'YYYYMMDDHH:mm:ss')
//           .toDate(),
//         volume: +(data.v.replace(/,/g, '')),
//         price: +(data.p.replace(/,/g, '')),
//         category: type,
//       }),
//     ).filter((data: any) => data);
//   };
//   return getDataFromAAStock(trials + 1);
// }

// async function fetchAASTradingData(stockId: number, date: Date): Promise<AASTradingData[]> {
//   const ubbullData = await fetchAASTradingDataSet(stockId, 'ubbull', date);
//   const bbullData = await fetchAASTradingDataSet(stockId, 'bbull', date);
//   const rbullData = await fetchAASTradingDataSet(stockId, 'rbull', date);
//   const rbearData = await fetchAASTradingDataSet(stockId, 'rbear', date);
//   const bbearData = await fetchAASTradingDataSet(stockId, 'bbear', date);
//   const ubbearData = await fetchAASTradingDataSet(stockId, 'ubbear', date);
//   return [
//     ...ubbullData,
//     ...bbullData,
//     ...rbullData,
//     ...rbearData,
//     ...bbearData,
//     ...ubbearData,
//   ];
// }

interface AASTopVolData {
  startAt: Date;
  endAt: Date;
  volume: number;
  netFlow: number;
  buyVol: number;
  buyPrice: number;
  sellVol: number;
  sellPrice: number;
  avgPrice: number;
  type: string;
}

async function convertAATradingDataTotopNVolData(tradingData: AASDetailTradingData[]): Promise<AASTopVolData[]> {
  const groupData = _.mapValues(
    _.groupBy(tradingData, d => moment(d.date).hour()),
    (d, key) => {
      const maxBuy = _.maxBy(
        d.filter(d => d.type === 'A'),
        d => d.volume,
      );
      const maxSell = _.maxBy(
        d.filter(d => d.type === 'B'),
        d => d.volume,
      );
      const startDate = _.get(_.minBy(d, 'date'), 'date');
      const endDate = _.get(_.maxBy(d, 'date'), 'date');
      return {
        startAt: moment(startDate).startOf('hour').toDate(),
        endAt: moment(endDate).endOf('hour').toDate(),
        volume: _.sumBy(d, 'volume'),
        buyPrice: maxBuy ? maxBuy.price : 0,
        buyVol: maxBuy ? maxBuy.volume : 0,
        sellPrice: maxSell ? maxSell.price: 0,
        sellVol: maxSell ? maxSell.volume: 0,
        netFlow: _.sum(d.map(d => d.type === 'A' ? (d.volume * d.price) : -(d.volume * d.price))),
        avgPrice: _.meanBy(d, d => d.price),
      } as AASTopVolData;
    });
  const topNData = _.sortBy(_.values(groupData), d => d.startAt).reverse();
  return topNData;
}

export async function seedStock(stockNumber: number) {
  const dir = path.join(__dirname, '../data');
  fs.ensureDirSync(dir);
  const stockId = `${stockNumber.toString().padStart(6, '0')}.HK`;

  const lastTradingDate = await fetchLatestTradingDate();

  const profilePath = path.join(__dirname, '../data', 
    `${stockId}_pf.json`);
  const profilePath2 = path.join(__dirname, '../data', 
    `${stockId}_pf${moment(lastTradingDate).format('YYYYMMDD')}.json`);
  if (
    !fs.existsSync(profilePath) ||
    (
      fs.existsSync(profilePath) &&
      moment(fs.statSync(profilePath).mtime).diff(lastTradingDate) < 0
    )
  ) {
    console.log(`[${stockId}]: Fetching Stock profile from Ticker...`);
    const profile = await fetchTickerStockProfile(stockNumber);
    fs.writeFileSync(profilePath, JSON.stringify(profile), { encoding:'utf8', flag: 'w' });
    const data = fs.readFileSync(profilePath, { encoding: 'utf8' });
    fs.writeFileSync(profilePath2, data, { encoding:'utf8', flag: 'w' });
  }

  const priceChartPath = path.join(
    __dirname, 
    '../data', 
    `${stockId}_pc${moment(lastTradingDate).format('YYYYMMDD')}.json`,
  );
  if (
    !fs.existsSync(priceChartPath) ||
    (
      fs.existsSync(priceChartPath) &&
      moment(fs.statSync(priceChartPath).mtime).diff(lastTradingDate) < 0
    )
  ) {
    console.log(`[${stockId}]: Fetching 5 day (in minute) data from Ticker...`);
    const pcData = await fetchTicker5DaysData(stockNumber);
    const output = _.sortBy(pcData, 'date');
    fs.writeFileSync(priceChartPath,
      JSON.stringify(output), { encoding:'utf8', flag: 'w' });
  }

  const filePath = path.join(__dirname, '../data', `${stockId}.json`);
  if (
    !fs.existsSync(filePath) ||
    (
      fs.existsSync(filePath) &&
      moment(fs.statSync(filePath).mtime).diff(lastTradingDate) < 0
    )
  ) {
    // fetch last 1 month data
    console.log(`[${stockId}]: Fetching 1 year data from Sina...`);
    const sinaCandles = await fetchSinaCandles(stockNumber);
    // get the last valid trading 4 date
    const lastNTradingDates = _.uniq([lastTradingDate]);
    console.log(`[${stockId}]: Fetching latest 1 day data from AAStock...`);
    const aasDatas = await Bluebird.mapSeries(
      lastNTradingDates,
      date => fetchAASDetailTradingData(stockNumber, date),
    );
    const aasCandles = _.sortBy(
      _.reduce(
        await Bluebird.mapSeries(
          aasDatas,
          data => convertAATradingDataToCandles(data, 'day'),
        ),
        (result, d) => ([
          ...result,
          ...d,
        ]),
        [] as AASCandle[],
      ),
      'date',
    );
    console.log(`[${stockId}]: Merging Sina data and AAStock data...`);
    const tradingData = await mergeSinaNAASCandles(aasCandles, sinaCandles);
    console.log(`[${stockId}]: Updating database...`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, { encoding: 'utf8' }));
      const output = _.sortBy(Object.values(_.merge(
        mapArrayToObject(data),
        mapArrayToObject(tradingData),
      )), 'date');
      fs.writeFileSync(filePath, JSON.stringify(output), { encoding:'utf8', flag: 'w' });
    } else {
      const output = tradingData;
      fs.writeFileSync(filePath, JSON.stringify(output), { encoding:'utf8', flag: 'w' });  
    }
    lastNTradingDates.map(
      (date, i) => fs.writeFileSync(
        path.join(__dirname, '..', `data/${stockId}_${moment(date).format('YYYYMMDD')}.json`),
        JSON.stringify(aasDatas[i]),
        { encoding:'utf8', flag: 'w' },
      ),
    );  
  }
  console.log(`[${stockId}]: Fetching Done!`);
}

export async function fetchStockNumbers(): Promise<number[]> {
  const { data } = await axios({
    method: 'get',
    url: 'http://www.hkexnews.hk/hyperlink/hyperlist.HTM',
  });
  // add some delay to prevent ban
  // .then(res => new Promise<AxiosResponse>(resolve => setTimeout(() => resolve(res), 500)));
  const $ = cheerio.load(data);
  const stocks = $('tr.tr_normal')
    .toArray()
    .reduce(
      (result, row) => {
        const stockNumber = $(row)
          .find('td:first-child')
          .text()
          .replace(/\s/g, '');
        return [
          ...result,
          +stockNumber,
        ];
      },
      [] as number[],
    );
  return stocks.filter(d => d && !Number.isNaN(d));
}

interface StockSummary {
  name: string;
  buy: boolean;
  sell: boolean;
  stockNumber: number;
  profile: TickerStockProfile;
  tradings: {
    topNVolDataByTime: AASTopVolData[][];
    data: AASDetailTradingData[][];
  };
  labels: {
    positiveCandle: boolean;
    bigPositiveCandle: boolean;
    negativeCandle: boolean;
    bigNegativeCandle: boolean;
    sanBaiBing: boolean;
    duoBaiBing: boolean;
    sanHaiBing: boolean;
    duoHaiBing: boolean;
    crossStar: boolean;
    jumpyBuy: boolean;
    active: boolean;
    stupid: boolean;
  };
  chart: string;
}

interface TickerTradingData {
  date: Date;
  close: number;
  high: number;
  low: number;
  open: number;
  volume: number;
}

async function fetchTicker5DaysData(
  stockId: number,
): Promise<TickerTradingData[]> {  const trials = 0;
  const getDataFromTicker = async (trials: number): Promise<TickerTradingData[]> => {
    if (trials > 5) {
      return [];
    }
    const { data } = await axios({
      url: `https://quote.ticker.com.hk/api/historical_data/detail/${
        stockId
      }.HK/5d`,
      method: 'get',
    });
    return (data.data || []).map(
      (d: any) => ({
        date: new Date(+d.time * 1000),
        close: +d.close,
        high: +d.high,
        low: +d.low,
        open: +d.open,
        volume: +d.volume,
      })) as TickerTradingData[];
  };
  return getDataFromTicker(trials + 1);
}

let aasToken: any = null;
async function fetchAASDetailTradingData(stockId: number, date: Date): Promise<AASDetailTradingData[]> {
  const trials = 0;

  const getDataFromAAStock = async (trials: number): Promise<AASDetailTradingData[]> => {
    // if (trials > 5) {
    //   return [];
    // }
    if (aasToken == null) {
      // first visit to aastock page to obtain the csrf token
      const res = await axios({
        method: 'get',
        url:
          'http://www.aastocks.com/en/stocks/analysis/transaction.aspx?symbol=' +
          `${stockId.toString().padStart(6, '0')}`,
      });
      const domData = res.data;
      
      // const searchUrl = 'http://tldata.aastocks.com/TradeLogServlet/getTradeLog?';
      const test = domData.match(new RegExp(`.+"&(u=.+&t=.+&d=.+)".+`));
      if (test != null) {
        aasToken = test[1];
      }
    }

    const query = qs.stringify({
      ...qs.parse(aasToken),
      id: `${stockId.toString().padStart(6, '0')}.HK`,
      date: moment(date).format('YYYYMMDD'),
    });
    try {
      const { data: tradingData } = await axios({
        method: 'get',
        url: `http://tldata.aastocks.com/TradeLogServlet/getTradeLog?${query}`,
      });
      if (`${tradingData}`.indexOf('#') === -1) {
        aasToken = null;
        return getDataFromAAStock(0);
      }
      return tradingData.substring(tradingData.indexOf('#') + 1).split('|').map(
        (data: string) => {
          const match = data.match(/(\d+);(\d+);(.);(\d+\.\d+);(.)/);
          if (match !== null) {
            const [,
              dateStr,
              volumeStr,
              labelStr,
              priceStr,
              typeStr,
            ] = match as any;
            return {
              type: typeStr,
              date: moment(moment(date).format('YYYYMMDD') + dateStr, 'YYYYMMDDHHmmss'),
              volume: +volumeStr,
              label: labelStr,
              price: +priceStr,
            };
          }
          return null;
        },
      ).filter((data: any) => data);
    } catch (e) {
      aasToken = null;
      return getDataFromAAStock(trials + 1);
    }
  };
  return getDataFromAAStock(trials + 1);
}

// export async function stockTransactionChart(stockNumber: number) {
//   const globPath = `../data/${stockNumber.toString().padStart(6, '0')}.HK_*.json`;
//   console.log(globPath);
//   console.log(glob.sync(globPath));
// }

// stockTransactionChart(1);

export async function analyzeStock(stockNumber: number, ignoreFilter: boolean = false, date?: Date): Promise<StockSummary | null> {
  const stockId = `${stockNumber.toString().padStart(6, '0')}.HK`;
  const pastProfilePath = path.join(__dirname, '..', `data/${stockId}_pf${moment(date).format('YYYYMMDD')}.json`);
  console.log(`[${stockId}]: Analyzing...`);
  const stockProfile = date != null ? 
    (fs.existsSync(pastProfilePath) ? JSON.parse(fs.readFileSync(pastProfilePath, { encoding: 'utf8' })) : 
    await fetchTickerStockProfile(stockNumber)) :
    await fetchTickerStockProfile(stockNumber);
  if (stockProfile == null || stockProfile.volume == null) return null;
  if (stockProfile.mktCap <= 200000000) console.log(`[${stockId}]: MarketCap <= 200000000...`);
  if (stockProfile == null || (!ignoreFilter && stockProfile.mktCap <= 1000000000)) return null;
  const changeAcceptable = true; // (stockProfile.changePercent >= -3);
  if (!ignoreFilter && !changeAcceptable) console.log(`[${stockId}]: Change is lower than -3%...`);
  if (ignoreFilter || changeAcceptable) {
    // read the monthly data
    const filePath = path.join(__dirname, '..', `data/${stockId}.json`);
    await seedStock(stockNumber);
    let candles = JSON.parse(fs.readFileSync(filePath, { encoding: 'utf8' })) as Candle[];
    if (date != null) candles = candles.filter(c => moment(c.date).diff(date) < 0);
    if (candles.length >= 4 ) {
      const abnormalVol = isAbnormalVolume(_.takeRight(candles, 5));
      if (!abnormalVol) console.log(`[${stockId}]: Volume is not abnormal (150% from 5 days average)...`);
      if (ignoreFilter || abnormalVol) {
        // labelize trading data
        const maxTradingDiff = _.max(candles.map(candle => candle.close - candle.open)) as number;
        const positiveCandle = isPositiveCandle(candles[candles.length - 1]);
        const bigPositiveCandle = isBigPositiveCandle(candles[candles.length - 1], stockProfile.open * 0.025);
        const negativeCandle = isNegativeCandle(candles[candles.length - 1]);
        const bigNegativeCandle = isBigNegativeCandle(candles[candles.length - 1], stockProfile.open * 0.025);
        const sanBaiBing = isSanbaibing(
          candles[candles.length - 1],
          candles[candles.length - 2],
          candles[candles.length - 3],
          candles[candles.length - 4],
          maxTradingDiff * 0.025,
        );
        const duoBaiBing = isDuobaibing(
          candles[candles.length - 1],
          candles[candles.length - 2],
          candles[candles.length - 3],
          maxTradingDiff * 0.025,
        );
        const sanHaiBing = isSanhaibing(
          candles[candles.length - 1],
          candles[candles.length - 2],
          candles[candles.length - 3],
          candles[candles.length - 4],
          maxTradingDiff * 0.025,
        );
        const duoHaiBing = isDuohaibing(
          candles[candles.length - 1],
          candles[candles.length - 2],
          candles[candles.length - 3],
          stockProfile.open * 0.025,
        );
        const crossStar = isCrossStar(
          candles[candles.length - 1],
          stockProfile.open * 0.025,
        );
        const jumpyBuy = isJumpyBuy(
          candles[candles.length - 1],
          candles[candles.length - 2],
          0.03,
        );
        const last10TradingDates = _.takeRight(candles, 10).map(d => d.date);
        console.log(`[${stockId}]: Get latest 4 days data...`);
        const aasDatas = await Bluebird.mapSeries(
          last10TradingDates,
          date => {
            const fPath = path.join(__dirname, '..', 'data', `${stockId}_${moment(date).format('YYYYMMDD')}.json`);
            // console.log(fPath);
            if (!fs.existsSync(fPath)) return [];
            // console.log('EXISTS');
            // console.log(fs.readFileSync(fPath, { encoding: 'utf8' }));
            return JSON.parse(fs.readFileSync(fPath, { encoding: 'utf8' })) as AASDetailTradingData[];
          },
        );
        const latestData = aasDatas[aasDatas.length - 1]
          .filter(d => d.type === 'A' || d.type === 'B');

        const tradingVolume = getTradingVolume(latestData);
        if (tradingVolume < 1000000) console.log(`[${stockId}]: Trading Volume < 1000000...`);
        if (!ignoreFilter && tradingVolume < 1000000) return null;

        const tradingCount = getTradingCount(latestData);
        if (tradingCount < 200) console.log(`[${stockId}]: Trading Count < 200...`);
        if (!ignoreFilter && tradingCount < 300) return null;

        const activeRate = getActiveRate(latestData);
        const active = activeRate >= 0.7;
        // if (activeRate < 0.2) console.log(`[${stockId}]: Active Rate < 0.2...`);
        // if (!ignoreFilter && activeRate < 0.2) return null;

        const buyVol = _.sumBy(
          latestData.filter(
            d => moment(d.date).hour() > 12 && d.type === 'A'),
          'volume',
        );
        const sellVol = _.sumBy(
          latestData.filter(
            d => moment(d.date).hour() > 12 && d.type === 'B'),
          'volume',
        );
        if (!ignoreFilter && bigNegativeCandle) {
          console.log(`[${stockId}]: Big Negative Candlestick...`);
          return null;
        }
        const buyMax = _.get(_.maxBy(
          latestData.filter(d => d.type === 'A'), 'volume'), 'volume', 0);
        const mean = _.meanBy(latestData, 'volume');
        let stupid = false;
        if (buyMax > mean * 20) {
          stupid = true;
        }

        if (!(buyVol >= sellVol * 1.2)) console.log(`[${stockId}]: Bullish < Bearish * 1.2...`);
        if (ignoreFilter || true/* || (buyVol >= sellVol * 1.2)*/) {
          const buyVol = getTradingVolume(latestData.filter(d => d.type === 'A'));
          const sellVol = getTradingVolume(latestData.filter(d => d.type === 'B'));
          const buy = (buyVol / sellVol) >= 1.5;
          if (buy) console.log(`[${stockId}]: Buy!`);
          const sell = buyVol < sellVol;
          if (sell) console.log(`[${stockId}]: Sell!`);
          // const topNVolDataByPrice = [
          //   await convertAATradingDataTotopNVolData(
          //     latestData.filter(d => d.type === 'A' || d.type === 'B'), 'price'),
          //   await convertAATradingDataTotopNVolData(
          //     aasDatas[aasDatas.length - 2].filter(d => d.type === 'A' || d.type === 'B'), 'price'),
          //   await convertAATradingDataTotopNVolData(
          //     aasDatas[aasDatas.length - 3].filter(d => d.type === 'A' || d.type === 'B'), 'price'),
          // ];
          // process.exit(1);
          const topNVolDataByTime = [
            await convertAATradingDataTotopNVolData(
              latestData.filter(
                d => d.type === 'A' ||  d.type === 'B',
              ),
            ),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 2].filter(
                d => d.type === 'A' ||  d.type === 'B',
              ),
            ),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 3].filter(
                d => d.type === 'A' ||  d.type === 'B',
              ),
            ),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 4].filter(
                d => d.type === 'A' ||  d.type === 'B',
              ),
            ),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 5].filter(
                d => d.type === 'A' ||  d.type === 'B',
              ),
            ),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 6].filter(
                d => d.type === 'A' ||  d.type === 'B',
              ),
            ),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 7].filter(
                d => d.type === 'A' ||  d.type === 'B',
              ),
            ),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 8].filter(
                d => d.type === 'A' ||  d.type === 'B',
              ),
            ),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 9].filter(
                d => d.type === 'A' ||  d.type === 'B',
              ),
            ),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 10].filter(
                d => d.type === 'A' ||  d.type === 'B',
              ),
            ),
          ];
          const stockName = await fetchTickerStockName(stockNumber);
          const summary = {
            stockNumber,
            buy,
            sell,
            name: stockName,
            profile: stockProfile,
            tradings: {
              topNVolDataByTime,
              data: [..._.takeRight(aasDatas, 10)].reverse(),
            },
            labels: {
              positiveCandle,
              bigPositiveCandle,
              negativeCandle,
              bigNegativeCandle,
              sanBaiBing,
              duoBaiBing,
              sanHaiBing,
              duoHaiBing,
              crossStar,
              jumpyBuy,
              active,
              stupid,
            },
            chart: 'http://charts.aastocks.com/servlet/Charts?' +
              'fontsize=12&15MinDelay=T&lang=1&titlestyle=1&' + 
              'vol=1&Indicator=1&' +
              'indpara1=10&indpara2=20&indpara3=50&indpara4=100&indpara5=150&' + 
              'subChart1=2&ref1para1=14&ref1para2=0&ref1para3=0&' + 
              'subChart3=12&ref3para1=0&ref3para2=0&ref3para3=0&' + 
              'scheme=3&com=100&chartwidth=673&chartheight=560&' +
              `stockid=${stockNumber.toString().padStart(
                6,
                '0',
              )}.HK&period=5&type=1&logoStyle=1&`,
          } as StockSummary;
          console.log(`[${stockId}]: Analysis Done!`);
          return summary;
        }
      }
    }
  }
  console.log(`[${stockId}]: Ignored, condition not match...`);
  return null;
}

export async function sendTradingsToSlack(
  trading: {
    hold: number[];
    buy: number[];
    canBuy: number[];
    sell: number[];
    canSell: number[];
    balance: number;
    transactions: { date: Date, stockNumber: number, type: 'A' | 'B' };
  },
  channel: '#general' | '#stock'
) {
  const slack = new Slack();
  slack.setWebhook(
    channel === '#general' ?
    process.env.SLACK_GENERAL_CHANNEL_WEBHOOK as string :
    process.env.SLACK_STOCK_CHANNEL_WEBHOOK as string,
  );
  return new Bluebird((resolve, reject) => {
    slack.webhook(
      {
        username: 'stockBot',
        attachments: [
          {
            color: '#0000FF',
            pretext: 
            `*程式現時組合: ${trading.hold.map(s => `\`${s.toString().padStart(6, '0')}.HK\``)}*\n` + 
            `*程式現時收入: \`${format(trading.balance * 100)}%\`*\n`,
            fields: [
              {
                value:
                  `*程式將會買入 ${trading.buy.map(s => `\`${s.toString().padStart(6, '0')}.HK\``)}*\n` +
                  `*程式將會沽出 ${trading.sell.map(s => `\`${s.toString().padStart(6, '0')}.HK\``)}*\n`,
                short: false,
              },
            ],
          },
        ],
      },
      (err, response) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

export async function sendStockNumbersToSlack(stockNumbers: number[], channel: '#general' | '#stock', date?: Date) {
  const slack = new Slack();
  slack.setWebhook(
    channel === '#general' ?
    process.env.SLACK_GENERAL_CHANNEL_WEBHOOK as string :
    process.env.SLACK_STOCK_CHANNEL_WEBHOOK as string,
  );
  const currentDate = date == null ? await fetchLatestTradingDate() : date;
  const stockIds = stockNumbers.map(
    stockNumber => `${stockNumber.toString().padStart(6, '0')}.HK`,
  );
  return new Bluebird((resolve, reject) => {
    slack.webhook(
      {
        username: 'stockBot',
        text:
          '<!everyone>' + `心水股: ${stockIds.map(s => `\`${s}\``).join(', ')}`,
        attachments: [
          {
            color: '#0000FF',
            fields: [
              {
                value:
                  `*股市戰報@${moment(currentDate).format('YYYY-MM-DD')}*\n` +
                  `心水股: ${stockIds.map(s => `*${s}*`).join(', ')}\n` +
                  `Command: \`/analyze ${stockNumbers.join(' ')}\``,
                short: false,
              },
            ],
          },
        ],
      },
      (err, response) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

export async function sendStockToSlack(summary: StockSummary, channel: '#general' | '#stock', date?: Date) {
  // setup the slack
  const slack = new Slack();
  slack.setWebhook(
    channel === '#general' ?
    process.env.SLACK_GENERAL_CHANNEL_WEBHOOK as string :
    process.env.SLACK_STOCK_CHANNEL_WEBHOOK as string,
  );
  const lastTradingDate = date == null ? await fetchLatestTradingDate(): date;
  return new Bluebird((resolve, reject) => {
    const labels = summary.labels;
    const stockName = summary.name;
    const stockNumber = summary.stockNumber;
    const profile = summary.profile;
    const price = profile.close;
    const color = (profile.changePrice === 0 ? '#666' : profile.changePrice > 0 ? '#00DD00' : '#DD0000');
    const pretext = `*${stockName}* *${stockNumber.toString().padStart(5, '0')}.HK`
      + `@${moment(lastTradingDate).format('YYYY-MM-DD')}*`;
    const earnPerUnit = (profile.pe != null) ? format(price / profile.pe) : '-';
    const pe = (profile.pe != null) ? format(+profile.pe) : '-';
    const topNVolDataByTime = summary.tradings.topNVolDataByTime;
    const tradingData = summary.tradings.data;
    const topVolByTimeMsgs = topNVolDataByTime.map(
      (d, j) => {
        return `總成交量: *${format(_.sumBy(tradingData[j], d => d.volume) / 10000)}萬股* ` +
          `總流入: *${format(_.sumBy(tradingData[j], d => d.type === 'A' ? (d.volume * d.price) : (-d.volume * d.price)) / 10000)}萬* ` +
          `平均價: *${format(_.meanBy(tradingData[j], d => d.price))}*\n` +
          d.map(
            (dt, i) => {
              return `_${moment(dt.startAt).format('HH:mm')}_ - _${moment(dt.endAt).format('HH:mm')}_ | ` + 
                `*${format(dt.buyVol / 10000 || 0)}萬股*, *${format(dt.buyPrice)}* | ` +
                `\`${format(dt.sellVol / 10000)}萬股\`, \`${format(dt.sellPrice)}\` | ` +
                `*${format(dt.netFlow/ 10000)}萬*, ${format(dt.volume/ 10000)}萬股, ${format(dt.avgPrice)}`;
            }
          ).join('\n');
      }
    ).join('\n\n');
    const message =
`股價/市值: *${price.toFixed(2)}*, *${format(profile.mktCap/100000000)}億*
每股盈利/市盈率: *${earnPerUnit}*, *${pe}*
升幅 (百分率，股價): *${profile.changePercent.toFixed(2)}%*, *${profile.changePrice.toFixed(2)}*
訊號: ${[
  labels.bigPositiveCandle ? '*大陽燭*' : null,
  !labels.bigPositiveCandle && labels.positiveCandle ? '*陽燭*' : null,
  labels.bigNegativeCandle ? '\`大陰燭\`' : null,
  !labels.bigNegativeCandle && labels.negativeCandle ? '\`陰燭\`' : null,
  labels.sanBaiBing ? '*三白兵*' : null,
  !labels.sanBaiBing && labels.duoBaiBing
    ? '*雙白兵*'
    : null,
  labels.sanHaiBing ? '\`三黑兵\`' : null,
  !labels.sanHaiBing && labels.duoHaiBing
    ? '\`雙黑兵\`'
    : null,
  labels.crossStar ? '*十字星*' : null,
  labels.jumpyBuy ? '*跳價高買*' : null,
  labels.active ? '*活躍股*' : null,
  (pe > 0) ? '*有盈利*' : null,
  labels.stupid ? '*傻強出沒請注意*' : null,
].filter(l => l).join(', ')}
`;
    slack.webhook(
      {
        text: pretext + '\n' + message,
        username: 'stockBot',
        attachments: [
          {
            color,
            pretext: '*====最近十日成交表====*',
            fields: [
              {
                short: false,
              },
            ],
            text: `時間 | (最高買入) 量，股價 | (最高賣出) 量，股價 | 淨流入，總量，平均價:\n${topVolByTimeMsgs}`,
            footer: `http://www.aastocks.com/tc/stocks/quote/detail-quote.aspx?symbol=${
              stockNumber.toString().padStart(6, '0')
            }`,
            image_url:
              'http://charts.aastocks.com/servlet/Charts?' +
              'fontsize=12&15MinDelay=T&lang=1&titlestyle=1&' + 
              'vol=1&Indicator=1&' +
              'indpara1=10&indpara2=20&indpara3=50&indpara4=100&indpara5=150&' + 
              'subChart1=2&ref1para1=14&ref1para2=0&ref1para3=0&' + 
              'subChart3=12&ref3para1=0&ref3para2=0&ref3para3=0&' + 
              'scheme=3&com=100&chartwidth=673&chartheight=560&' +
              `stockid=${stockNumber.toString().padStart(6, '0')}` + 
              `.HK&period=5&type=1&logoStyle=1&`,
          },
        ],
      },
      (err, response) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}
