import * as qs from 'qs';
import * as path from 'path';
import * as fs from 'fs-extra';
import axios /*, { AxiosResponse }*/ from 'axios';
import * as cheerio from 'cheerio';
import * as moment from 'moment';
import * as Slack from 'slack-node';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';

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

function getActiveRate(candles: AASTradingData[]) {
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
  const lastDayData = candles[candles.length - 1];
  const prevData = _.take(candles, candles.length - 1);
  const avgVol = _.sumBy(prevData, 'volume') / prevData.length;
  return _.defaultTo(lastDayData.volume, lastDayData.normVolume) >= 4.5 * avgVol;
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

async function fetchTickerStockProfile(stockId: number): Promise<TickerStockProfile> {
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

interface AASTradingData {
  type: string;
  date: Date;
  volume: number;
  auto: boolean;
  price: number;
  category: 'ubbull' | 'bbull' | 'rbull' | 'rbear' | 'bbear' | 'ubbear';
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
  return getDataFromSina(trials);
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

  return getDataFromAAStock(trials);
}

function mapArrayToObject(
  candles: Candle[],
): { [index: string]: Candle } {
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
  tradingData: AASTradingData[],
  dividend: 'minute' | 'day',
): AASCandle[] {
  const data = _.groupBy(
    tradingData,
    d => moment(d.date).startOf(dividend).toISOString(),
  );
  return _.sortBy(
    Object.values(_.mapValues(data, (d: AASTradingData[], date: string) => {
      const highestPriceData = _.maxBy(d, 'price') as AASTradingData;
      const lowestPriceData = _.minBy(d, 'price') as AASTradingData;
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

async function fetchAASTradingDataSet(
  stockId: number,
  type: 'ubbull' | 'bbull' | 'rbull' | 'ubbear' | 'bbear' | 'rbear',
  date: Date,
): Promise<AASTradingData[]> {
  const trials = 0;
  const getDataFromAAStock = async (trials: number): Promise<AASTradingData[]> => {
    if (trials > 5) {
      throw new Error('Unable to fetch latest trading transactions from AAStock');
    }
    const { data } = await axios({
      method: 'get',
      url: `http://wdata.aastocks.com/datafeed/getultrablocktradelog.ashx?` +
        qs.stringify({
          type,
          symbol: stockId.toString().padStart(6, '0'),
          lang: 'en',
          dt: moment(date).format('YYYYMMDD'),
          f: 1,
        }),
    });
    // if error, retry getting data from aastock
    if (data === '-1') {
      return getDataFromAAStock(trials + 1);
    }
    const { tslog: tradingData } = data;
    return tradingData.map(
      (data: any) => ({
        type: type.endsWith('bull') ? 'A' : 'B',
        date: moment(moment(date).format('YYYYMMDD') + data.dt, 'YYYYMMDDHH:mm:ss')
          .toDate(),
        volume: +(data.v.replace(/,/g, '')),
        price: +(data.p.replace(/,/g, '')),
        category: type,
      }),
    ).filter((data: any) => data);
  };
  return getDataFromAAStock(trials);
}

async function fetchAASTradingData(stockId: number, date: Date): Promise<AASTradingData[]> {
  const ubbullData = await fetchAASTradingDataSet(stockId, 'ubbull', date);
  const bbullData = await fetchAASTradingDataSet(stockId, 'bbull', date);
  const rbullData = await fetchAASTradingDataSet(stockId, 'rbull', date);
  const rbearData = await fetchAASTradingDataSet(stockId, 'rbear', date);
  const bbearData = await fetchAASTradingDataSet(stockId, 'bbear', date);
  const ubbearData = await fetchAASTradingDataSet(stockId, 'ubbear', date);
  return [
    ...ubbullData,
    ...bbullData,
    ...rbullData,
    ...rbearData,
    ...bbearData,
    ...ubbearData,
  ];
}

interface AASTopVolData {
  startAt: Date;
  endAt: Date;
  volume: number;
  price: number;
  type: string;
}

async function convertAATradingDataTotopNVolData(tradingData: AASTradingData[], groupBy?: 'price'): Promise<AASTopVolData[]> {
  const buyData = tradingData.filter(d => d.type === 'A');
  const buyGroupData = _.mapValues(
    groupBy? _.groupBy(buyData, groupBy) : _.chunk(buyData, 1),
    (d, key) => ({
      startAt: _.get(_.minBy(d, 'date'), 'date'),
      endAt: _.get(_.maxBy(d, 'date'), 'date'),
      volume: _.sumBy(d, 'volume'),
      price: groupBy === 'price' ? +key : d[0].price,
      type: 'A',
    } as AASTopVolData));
  const topNBuyData = _.takeRight(_.sortBy(Object.values(buyGroupData), 'volume'), 3);
  const sellData = tradingData.filter(d => d.type === 'B');
  const sellGroupData = _.mapValues(
    groupBy? _.groupBy(sellData, groupBy) : _.chunk(sellData, 1),
    (d, key) => ({
      startAt: _.get(_.minBy(d, 'date'), 'date'),
      endAt: _.get(_.maxBy(d, 'date'), 'date'),
      volume: _.sumBy(d, 'volume'),
      price: groupBy === 'price' ? +key : d[0].price,
      type: 'B',
    } as AASTopVolData));
  const topNSellData = _.takeRight(_.sortBy(Object.values(sellGroupData), 'volume'), 3);
  return [...topNBuyData, ...topNSellData];
}

export async function seedStock(stockNumber: number) {
  const dir = path.join(__dirname, '../data');
  fs.ensureDirSync(dir);
  const stockId = `${stockNumber.toString().padStart(6, '0')}.HK`;
  console.log(`[${stockId}]: Fetching Stock profile from Ticker...`);
  await fetchTickerStockProfile(stockNumber);
  // fetch last 1 month data
  console.log(`[${stockId}]: Fetching 1 year data from Sina...`);
  const sinaCandles = await fetchSinaCandles(stockNumber);
  // get the last valid trading 4 date
  const lastNTradingDates = _.takeRight(sinaCandles, 1).map(d => d.date);
  console.log(`[${stockId}]: Fetching latest 1 day data from AAStock...`);
  const aasDatas = await Bluebird.mapSeries(
    lastNTradingDates,
    date => fetchAASTradingData(stockNumber, date),
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
  const filePath = path.join(__dirname, '../data', `${stockId}.json`);
  if (fs.existsSync(filePath)) {
    const data = JSON.parse(fs.readFileSync(filePath, { encoding: 'utf8' }));
    const output = _.sortBy(Object.values(_.merge(
      mapArrayToObject(data),
      mapArrayToObject(tradingData),
    )), 'date');
    fs.writeFileSync(filePath, JSON.stringify(output));
  } else {
    const output = tradingData;
    fs.writeFileSync(filePath, JSON.stringify(output));  
  }
  lastNTradingDates.map(
    (date, i) => fs.writeFileSync(
      path.join(__dirname, '..', `data/${stockId}_${moment(date).format('YYYYMMDD')}.json`),
      JSON.stringify(aasDatas[i]),
    ),
  );

  console.log(`[${stockId}]: Done!`);
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
  stockNumber: number;
  profile: TickerStockProfile;
  tradings: {
    topNVolDataByPrice: AASTopVolData[][];
    topNVolDataByTime: AASTopVolData[][];
    data: AASTradingData[][];
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
  };
  chart: string;
}

export async function analyzeStock(stockNumber: number, ignoreFilter: boolean = false): Promise<StockSummary | null> {
  const stockId = `${stockNumber.toString().padStart(6, '0')}.HK`;
  console.log(`[${stockId}]: Analyzing...`);
  const stockProfile = await fetchTickerStockProfile(stockNumber);
  if (stockProfile == null || stockProfile.volume == null) return null;
  if (stockProfile.mktCap <= 1000000000) console.log(`[${stockId}]: MarketCap <= 1000000000...`);
  if (stockProfile == null || (!ignoreFilter && stockProfile.mktCap <= 1000000000)) return null;
  const changeAcceptable = true; // (stockProfile.changePercent >= -3);
  if (!ignoreFilter && !changeAcceptable) console.log(`[${stockId}]: Change is lower than -3%...`);
  if (ignoreFilter || changeAcceptable) {
    const stockName = await fetchTickerStockName(stockNumber);
    // read the monthly data
    const profilePath = path.join(__dirname, '..', `data/${stockId}_pf.json`);
    const filePath = path.join(__dirname, '..', `data/${stockId}.json`);
    await seedStock(stockNumber);
    const candles = JSON.parse(fs.readFileSync(filePath, { encoding: 'utf8' })) as Candle[];
    const profile = JSON.parse(fs.readFileSync(profilePath, { encoding: 'utf8' })) as TickerStockProfile;
    if (candles.length >= 4 ) {
      const abnormalVol = isAbnormalVolume(candles);
      if (!abnormalVol) console.log(`[${stockId}]: Volume is not abnormal (450% from year average)...`);
      if (ignoreFilter || abnormalVol) {
        // labelize trading data
        const maxTradingDiff = _.max(candles.map(candle => candle.close - candle.open)) as number;
        const positiveCandle = isPositiveCandle(candles[candles.length - 1]);
        const bigPositiveCandle = isBigPositiveCandle(candles[candles.length - 1], profile.open * 0.025);
        const negativeCandle = isNegativeCandle(candles[candles.length - 1]);
        const bigNegativeCandle = isBigNegativeCandle(candles[candles.length - 1], profile.open * 0.025);
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
          profile.open * 0.025,
        );
        const crossStar = isCrossStar(
          candles[candles.length - 1],
          profile.open * 0.025,
        );
        const jumpyBuy = isJumpyBuy(
          candles[candles.length - 1],
          candles[candles.length - 2],
          0.03,
        );
        const last4TradingDates = _.takeRight(candles, 4).map(d => d.date);
        console.log(`[${stockId}]: Fetching latest 4 days data from AAStock...`);
        const aasDatas = await Bluebird.mapSeries(
          last4TradingDates,
          date => {
            const fPath = path.join(__dirname, '..', 'data', `${stockId}_${moment(date).format('YYYYMMDD')}.json`);
            return JSON.parse(fs.readFileSync(fPath, { encoding: 'utf8' })) as AASTradingData[];
          },
        );
        const latestData = aasDatas[aasDatas.length - 1];

        const activeRate = getActiveRate(latestData);
        const active = activeRate >= 0.5;
        if (activeRate < 0.1) console.log(`[${stockId}]: Active Rate < 0.1...`);
        if (!ignoreFilter && activeRate < 0.1) return null;

        const ubbullVol = _.sumBy(
          latestData.filter(d => d.category === 'ubbull'),
          'volume',
        );
        const ubbearVol = _.sumBy(
          latestData.filter(d => d.category === 'ubbear'),
          'volume',
        );
        if (bigNegativeCandle) {
          console.log(`[${stockId}]: Big Negative Candlestick...`);
          return null;
        }
        if (!(ubbullVol >= ubbearVol)) console.log(`[${stockId}]: Ultra Bullish < Ultra Bearish...`);
        if (ignoreFilter || (ubbullVol >= ubbearVol)) {
          const topNVolDataByPrice = [
            await convertAATradingDataTotopNVolData(
              latestData.filter(d => d.category === 'ubbull' || d.category === 'ubbear'), 'price'),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 2].filter(d => d.category === 'ubbull' || d.category === 'ubbear'), 'price'),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 3].filter(d => d.category === 'ubbull' || d.category === 'ubbear'), 'price'),
          ];
          const topNVolDataByTime = [
            await convertAATradingDataTotopNVolData(
              latestData.filter(d => d.category === 'ubbull' || d.category === 'ubbear')),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 2].filter(d => d.category === 'ubbull' || d.category === 'ubbear')),
            await convertAATradingDataTotopNVolData(
              aasDatas[aasDatas.length - 3].filter(d => d.category === 'ubbull' || d.category === 'ubbear')),
          ];
          const summary = {
            stockNumber,
            name: stockName,
            profile: stockProfile,
            tradings: {
              topNVolDataByPrice,
              topNVolDataByTime,
              data: [..._.takeRight(aasDatas, 3)].reverse(),
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

export async function sendStockNumbersToSlack(stockNumbers: number[], channel: '#general' | '#stock') {
  const slack = new Slack();
  slack.setWebhook(
    channel === '#general' ?
    process.env.SLACK_GENERAL_CHANNEL_WEBHOOK as string :
    process.env.SLACK_STOCK_CHANNEL_WEBHOOK as string,
  );
  const date = await fetchLatestTradingDate();
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
                  `*股市戰報@${moment(date).format('YYYY-MM-DD')}*\n` +
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

export async function sendStockToSlack(summary: StockSummary, channel: '#general' | '#stock') {
  // setup the slack
  const slack = new Slack();
  slack.setWebhook(
    channel === '#general' ?
    process.env.SLACK_GENERAL_CHANNEL_WEBHOOK as string :
    process.env.SLACK_STOCK_CHANNEL_WEBHOOK as string,
  );
  const filePath = path.join(__dirname, '..', `data/${summary.stockNumber.toString().padStart(6, '0')}.HK.json`);
  const candles = JSON.parse(fs.readFileSync(filePath, { encoding: 'utf8' })) as Candle[];
  const last4TradingDates = _.takeRight(candles, 4).map(d => d.date).reverse();
  return new Bluebird((resolve, reject) => {
    const labels = summary.labels;
    const stockName = summary.name;
    const stockNumber = summary.stockNumber;
    const profile = summary.profile;
    const price = profile.open + profile.changePrice;
    const color = (profile.changePrice === 0 ? '#666' : profile.changePrice > 0 ? '#00DD00' : '#DD0000');
    const pretext = `*${stockName}* *${stockNumber.toString().padStart(5, '0')}.HK`
      + `@${moment(last4TradingDates[0]).format('YYYY-MM-DD')}*`;
    const earnPerUnit = (profile.pe != null) ? format(price / profile.pe) : '-';
    const pe = (profile.pe != null) ? format(+profile.pe) : '-';
    const topNVolDataByPrice = summary.tradings.topNVolDataByPrice;
    const topNVolDataByTime = summary.tradings.topNVolDataByTime;
    const tradingData = summary.tradings.data;
    const topVolByTimeMsgs = topNVolDataByTime.map(
      (d, j) => {
        const topNBuyData = _.sortBy(d.filter(dt => dt.type === 'A'), 'volume').reverse();
        const topNSellData = _.sortBy(d.filter(dt => dt.type === 'B'), 'volume').reverse();
        return '' +
          '_' + moment(last4TradingDates[j]).format('YYYY-MM-DD') + '_' +
          '  總成交量: *' + format(_.sumBy(tradingData[j], 'volume')) + '*' +
          ' 超大手買佔: *' + format(_.sumBy(tradingData[j].filter(d => d.category === 'ubbull'), 'volume')) + '*' +
          ' 超大手賣佔: *' + format(_.sumBy(tradingData[j].filter(d => d.category === 'ubbear'), 'volume')) + '*' +
          '\n' +
          new Array(Math.max(topNBuyData.length, topNSellData.length))
            .fill('').map(
            (dt, i) => {
              const b = topNBuyData[i];
              const s = topNSellData[i];
              return '    ' +
                (b != null ?
                  `*${moment(b.startAt).format('HH:mm')}*, *${format(b.volume)}*, *${format(b.price)}*`
                  : '-'
                ) +
                '  |  ' +
                (s != null ?
                  `\`${moment(s.startAt).format('HH:mm')}\`, \`${format(s.volume)}\`, \`${format(s.price)}\``
                  : '-'
                )
            }
          ).join('\n');
      }
    ).join('\n');
    const topVolByPriceMsgs = topNVolDataByPrice.map(
      (d, j) => {
        const topNBuyData = _.sortBy(d.filter(dt => dt.type === 'A'), 'price').reverse();
        const topNSellData = _.sortBy(d.filter(dt => dt.type === 'B'), 'price').reverse();
        return '_' + moment(last4TradingDates[j]).format('YYYY-MM-DD') + '_' +
          '  總成交量: *' + format(_.sumBy(tradingData[j], 'volume')) + '*' +
          ' 大手買佔: *' + format(_.sumBy(tradingData[j].filter(d => d.category === 'bbull'), 'volume')) + '*' +
          ' 大手賣佔: *' + format(_.sumBy(tradingData[j].filter(d => d.category === 'bbear'), 'volume')) + '*' +
          '\n' +
          new Array(Math.max(topNBuyData.length, topNSellData.length))
            .fill('').map(
              (dt, i) => {
                const b = topNBuyData[i];
                const s = topNSellData[i];
                return '    ' +
                  (b != null ?
                    `*${moment(b.startAt).format('HH:mm')} - ${moment(b.endAt).format('HH:mm')}*, *${format(b.volume)}*, *${format(b.price)}*`
                    : '-'
                  ) +
                  '  |  ' +
                  (s != null ?
                    `\`${moment(s.startAt).format('HH:mm')} - ${moment(s.endAt).format('HH:mm')}\`, \`${format(s.volume)}\`, \`${format(s.price)}\``
                    : '-'
                  ) 
              }
            ).join('\n');
      }
    ).join('\n');
    const message =
`股價: *${price.toFixed(2)}*
每股盈利/市盈率: *${earnPerUnit}*, *${pe}*
升幅 (百分率，股價): *${profile.changePercent.toFixed(2)}%*, *${profile.changePrice.toFixed(2)}*
最高買入/賣出成交量(超大手) - 以時間分類 (時間, 成交量，股價):
${topVolByTimeMsgs}
最高買入/賣出成交量(超大手) - 以股價分類 (時間, 成交量，股價):
${topVolByPriceMsgs}
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
].filter(l => l).join(', ')}
`;

    slack.webhook(
      {
        username: 'stockBot',
        attachments: [
          {
            color,
            pretext,
            fields: [
              {
                value: message,
                short: false,
              },
            ],
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
