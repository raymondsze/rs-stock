import * as qs from 'qs';
import * as path from 'path';
import * as fs from 'fs-extra';
import axios /*, { AxiosResponse }*/ from 'axios';
import * as cheerio from 'cheerio';
import * as moment from 'moment';
import * as Slack from 'slack-node';
import * as Bluebird from 'bluebird';

/* tslint:disable */
axios.interceptors.response.use(
  undefined as any,
  function axiosRetryInterceptor(err: any) {
    var config = err.config;

    // add retry mechanism
    config.retry = 5;
    config.retryDelay = 500;

    // If config does not exist or the retry option is not set, reject
    if (!config || !config.retry) return Promise.reject(err);

    // Set the variable for keeping track of the retry count
    config.__retryCount = config.__retryCount || 0;

    // Check if we've maxed out the total number of retries
    if (config.__retryCount >= config.retry) {
      // Reject with the error
      return Promise.reject(err);
    }

    // Increase the retry count
    config.__retryCount += 1;

    // Create new promise to handle exponential backoff
    var backoff = new Promise(function(resolve) {
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
/* tslint:enable*/

interface Stocks {
  [index: string]: string;
}

const runDate = moment();

// obtain all stock numbers
async function getStocks(): Promise<Stocks> {
  const { data } = await axios({
    method: 'get',
    url: 'http://www.hkexnews.hk/hyperlink/hyperlist.HTM',
  });
  // add some delay to prevent ban
  // .then(res => new Promise<AxiosResponse>(resolve => setTimeout(() => resolve(res), 500)));
  const $ = cheerio.load(data);
  const stocks = $('tr.tr_normal')
    .toArray()
    .reduce((result, row) => {
      const stockNumber = $(row)
        .find('td:first-child')
        .text()
        .replace(/\s/g, '');
      if (stockNumber.length !== 4) return result;
      return {
        ...result,
        [stockNumber]: $(row)
          .find('td:nth-child(2)')
          .text()
          .trim(),
      };
    }, {});
  return stocks;
}

interface StockDailyData {
  date: Date;
  close: number;
  change: number;
  change_percent: number;
  volume: number;
  volume_price: number;
  open: number;
  highest: number;
  lowest: number;
  amp: number;
}

interface StockData {
  [index: string]: StockDailyData;
}

let lastTradingDate: Date | null = null;
async function getLastTradingDate() {
  if (lastTradingDate != null) return lastTradingDate;
  const { data } = await axios({
    url: 'https://quote.ticker.com.hk/api/historical_data/detail/700.HK/1m',
    method: 'get',
  });
  lastTradingDate = moment(data.meta['last-trade'], 'YYYYMMDD').toDate();
  return lastTradingDate;
}

// obtain all stock data
async function getStockSeasonData(
  stockId: number,
  year: number,
  season: number,
): Promise<StockData> {
  const month = moment().month();
  const monthToSeason = [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
  let data = {};
  fs.ensureDirSync(path.join(process.cwd(), 'data'));
  const filePath = path.join(
    process.cwd(),
    'data',
    `${stockId}_${year}_${season}.json`,
  );
  const tradeDate = await getLastTradingDate();
  let forceFetch = !fs.existsSync(filePath);
  if (year === moment().year() && monthToSeason[+month] === season) {
    if (fs.existsSync(filePath)) {
      data = JSON.parse(
        fs.readFileSync(filePath, { encoding: 'utf-8' }),
      ) as StockData;
      if (data[moment(tradeDate).toISOString()] == null) {
        forceFetch = true;
      }
    } else {
      forceFetch = true;
    }
  }
  if (forceFetch) {
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
      close: numberParser,
      change: numberParser,
      change_percent: numberParser,
      volume: numberParser,
      volume_price: numberParser,
      open: numberParser,
      highest: numberParser,
      lowest: numberParser,
      amp: numberParser,
    };
    const $ = cheerio.load(domData);
    const stockData = $('tr')
      .toArray()
      .reverse()
      .reduce(
        (result, row, index) => {
          const columns = $(row)
            .find('td')
            .toArray();
          const dailyData = columns.reduce(
            (innerResult, col, i) =>
              columnRefs.length > i
                ? {
                    ...innerResult,
                    [columnRefs[i]]: parsers[columnRefs[i]](
                      $(col)
                        .text()
                        .trim(),
                    ),
                  }
                : innerResult,
            {},
          ) as StockDailyData;
          const date = moment(moment(dailyData.date).toISOString());
          if (!date.isValid()) return result;
          return {
            ...result,
            [date.toISOString()]: dailyData,
          };
        },
        {} as StockData,
      );
    fs.writeFileSync(filePath, JSON.stringify(stockData));
    return stockData;
  }
  return JSON.parse(fs.readFileSync(filePath, { encoding: 'utf-8' }));
}

// 每日數據
async function getStockData(
  stockId: number,
  startYear: number = 2001,
  endYear: number = +runDate.year(),
): Promise<StockData> {
  const seasons = [1, 2, 3, 4];
  const years: { year: number; season: number }[] = Array(
    endYear - startYear + 1,
  )
    .fill(0)
    .reduce(
      (result, _, index) => [
        ...result,
        ...seasons.map(season => ({
          season,
          year: startYear + index,
        })),
      ],
      [],
    );
  // if call too frequently, may got banned
  const data = await Promise.all(
    years.map(year => getStockSeasonData(stockId, year.year, year.season)),
  );
  // const data = await Bluebird.mapSeries(
  //   years,
  //   year => getStockSeasonData(stockId, year.year, year.season),
  // );
  return data.reduce(
    (result, seasonData) => ({
      ...result,
      ...seasonData,
    }),
    {},
  );
}

// 異動成交量
function isAbnormalVolume(stockData: StockData) {
  const stockDataValues = Object.values(stockData);
  const lastDayData = stockDataValues[stockDataValues.length - 1];
  const pastAvgVolume = stockDataValues.reduce(
    (result, dailyData) =>
      result +
      (moment(dailyData.date).toISOString() !==
      moment(lastDayData.date).toISOString()
        ? dailyData.volume / (stockDataValues.length - 1)
        : 0),
    0,
  );
  return lastDayData.volume >= 4.5 * pastAvgVolume;
}

interface StockTradingData {
  [index: string]: StockDailyTradingData;
}

interface StockDailyTradingData {
  time: Date;
  close: number;
  high: number;
  low: number;
  open: number;
  volume: number;
  ratio: number;
  positive: boolean;
  negative: boolean;
  bigPositive: boolean;
  bigNegative: boolean;
  crossStar: boolean;
  sanbaibing?: boolean;
  duobaibing?: boolean;
  jumpyBuy?: boolean;
}

async function getTradingData(
  stockId: number,
  bigCandleThreshold: number,
  jumpyThreshold: number,
  category: '1y' | '6m' | '3m' | '1m' | '1d' = '1m',
): Promise<StockTradingData> {
  const {
    data,
  }: {
    data: {
      data: {
        time: string;
        close: string;
        high: string;
        low: string;
        open: string;
        volume: string;
      }[];
    };
  } = await axios({
    url: `https://quote.ticker.com.hk/api/historical_data/detail/${
      stockId
    }.HK/${category}`,
    method: 'get',
  });
  // add some delay to prevent ban
  // .then(res => new Promise<AxiosResponse>(resolve => setTimeout(() => resolve(res), 500)));
  const tempData = data.data.map(dailyData => {
    return {
      ...dailyData,
      time:
        category === '1d'
          ? new Date(+dailyData.time * 1000)
          : moment(dailyData.time, 'YYYYMMDD').toDate(),
      close: +dailyData.close,
      high: +dailyData.high,
      low: +dailyData.low,
      open: +dailyData.open,
      volume: +dailyData.volume,
    };
  });
  const normalizedData = tempData.map(dailyData => {
    const ratio = getTradingPriceRatio(dailyData as any);
    return {
      ...dailyData,
      ratio,
      positive: isPositiveCandle({ ratio, ...dailyData } as any),
      negative: isNegativeCandle({ ratio, ...dailyData } as any),
      bigPositive: isBigPositiveCandle(
        { ratio, ...dailyData } as any,
        bigCandleThreshold,
      ),
      bigNegative: isBigNegativeCandle(
        { ratio, ...dailyData } as any,
        bigCandleThreshold,
      ),
      crossStar: isCrossStar(
        { ratio, ...dailyData } as any,
        bigCandleThreshold,
      ),
    };
  });
  const prevData = [] as StockDailyTradingData[];
  return normalizedData.reduce((result, dailyData, index) => {
    const ratio = getTradingPriceRatio(dailyData);
    const newData = {
      ...dailyData,
      ratio,
      close: +dailyData.close,
      high: +dailyData.high,
      low: +dailyData.low,
      open: +dailyData.open,
      volume: +dailyData.volume,
    };
    prevData.push(newData);
    return {
      ...result,
      [moment(newData.time).toISOString()]: {
        ...newData,
        duobaibing:
          index >= 2
            ? isDuobaibing(newData, prevData[prevData.length - 2])
            : false,
        sanbaibing:
          index >= 3
            ? isSanbaibing(
                newData,
                prevData[prevData.length - 2],
                prevData[prevData.length - 3],
              )
            : false,
        jumpyBuy:
          index >= 2
            ? isJumpyBuy(newData, prevData[prevData.length - 2], jumpyThreshold)
            : false,
      },
    };
  }, {});
}

function getTradingPriceRatio(dailyData: StockDailyTradingData) {
  const priceRange = dailyData ? +dailyData.high - +dailyData.low : 0;
  const tradingPriceRange = dailyData ? +dailyData.close - +dailyData.open : 0;
  const ratio = tradingPriceRange / priceRange;
  // if ratio >= 0.4 = 大陽燭
  // if ratio <= -0.4 = 大陰燭
  // if positive = 陽燭
  // if negative = 陰燭
  return Number.isNaN(ratio) ? 0 : ratio;
}

// 陽燭
function isPositiveCandle(data: StockDailyTradingData) {
  return data.ratio > 0;
}

// 大陽燭
function isBigPositiveCandle(
  data: StockDailyTradingData,
  bigCandleThreshold: number,
) {
  return (
    Math.abs(data.high - data.low) > bigCandleThreshold && data.ratio >= 0.4
  );
}

// 陰燭
function isNegativeCandle(data: StockDailyTradingData) {
  return data.ratio < 0;
}

// 大陰燭
function isBigNegativeCandle(
  data: StockDailyTradingData,
  bigCandleThreshold: number,
) {
  return (
    Math.abs(data.high - data.low) > bigCandleThreshold && data.ratio <= -0.4
  );
}

// 十字星
function isCrossStar(data: StockDailyTradingData, bigCandleThreshold: number) {
  if (
    Math.abs(data.high - data.low) > bigCandleThreshold &&
    data.ratio <= 0.1
  ) {
    const nominator = data.high - Math.max(data.close, data.open);
    const denominator = Math.max(data.close, data.open) - data.low;
    if (nominator / denominator > 0.6 && nominator / denominator < 1.4) {
      return true;
    }
  }
  return false;
}

// 三白兵
function isSanbaibing(
  targetData: StockDailyTradingData,
  yData: StockDailyTradingData,
  dbyData: StockDailyTradingData,
) {
  // if increasing trend
  if (targetData.high > yData.high && yData.high > dbyData.high) {
    if (
      isPositiveCandle(targetData) &&
      isPositiveCandle(yData) &&
      isPositiveCandle(dbyData)
    ) {
      return true;
    }
  }
  return false;
}

function isDuobaibing(
  targetData: StockDailyTradingData,
  yData: StockDailyTradingData,
) {
  // if increasing trend
  if (targetData.high > yData.high) {
    if (isPositiveCandle(targetData) && isPositiveCandle(yData)) {
      return true;
    }
  }
  return false;
}

// 跳價高買
function isJumpyBuy(
  targetData: StockDailyTradingData,
  yData: StockDailyTradingData,
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

// 當日最高買入額
function getHighestBuyTradingVolumeData(tradingData: StockTradingData) {
  const values = Object.values(tradingData);
  const max = values.reduce(
    (vol, data) => (data.positive ? Math.max(vol, data.volume) : vol),
    0,
  );
  const data = values.find(data => data.positive && data.volume === max);
  return data == null ? null : data;
}

// 當日最高賣出額
function getHighestSellTradingVolumeData(tradingData: StockTradingData) {
  const values = Object.values(tradingData);
  const max = values.reduce(
    (vol, data) => (data.negative ? Math.max(vol, data.volume) : vol),
    0,
  );
  const data = values.find(data => data.negative && data.volume === max);
  return data == null ? null : data;
}

// 市值
interface StockProfile {
  name: string;
  yield: number;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  mktCap: number;
}

async function getStockProfile(stockId: number): Promise<StockProfile> {
  const { data } = await axios({
    method: 'get',
    url: `https://quote.ticker.com.hk/api/quote/detail/${stockId}.HK`,
    headers: {
      'Accept-Language': 'zh-HK',
    },
  });
  // add some delay to prevent ban
  // .then(res => new Promise<AxiosResponse>(resolve => setTimeout(() => resolve(res), 500)));
  const profile = data[0];
  return {
    name: profile['name'],
    yield: profile['yield'],
    open: profile['Open'],
    close: profile['lastClosePrice'],
    high: profile['High'],
    low: profile['Low'],
    volume: profile['Vol'],
    mktCap: profile['MktCap'],
  };
}

interface StockSummary {
  id: string;
  name: string;
  price: number;
  changePercent: number;
  change: number;
  highestBigBuyTradingData: StockDailyTradingData;
  highestBigSellTradingData: StockDailyTradingData;
  positive: boolean;
  negative: boolean;
  bigPositive: boolean;
  bigNegative: boolean;
  sanbaibing: boolean;
  duobaibing: boolean;
  crossStar: boolean;
  jumpyBuy: boolean;
  yield: number;
  hasYield: boolean;
  active: boolean;
}

// function getCloseStandardDeviation(stockData: StockTradingData) {
//   const values = Object.values(stockData);
//   const average = values.reduce((result, d) => result + (d.close / values.length), 0);
//   const nominator = values.reduce((result, d) => Math.pow(d.close - average, 2), 0);
//   const denominator = values.length - 1;
//   return Math.sqrt(nominator / denominator);
// }

// function getOpenStandardDeviation(stockData: StockTradingData) {
//   const values = Object.values(stockData);
//   const average = values.reduce((result, d) => result + (d.open / values.length), 0);
//   const nominator = values.reduce((result, d) => Math.pow(d.open - average, 2), 0);
//   const denominator = values.length - 1;
//   return Math.sqrt(nominator / denominator);
// }

function getActiveRate(stockData: StockTradingData) {
  const values = Object.values(stockData);
  const nonActiveCandles = values.filter(
    d => d.high.toFixed(2) === d.low.toFixed(2),
  );
  return 1 - nonActiveCandles.length / values.length;
}

async function analyzeStock(stockId: number) {
  const profile = await getStockProfile(stockId);
  // if the stock is already stopped, the volume should be empty or 0
  // we should ignore it
  if (!profile.volume) return undefined;
  if (profile.mktCap > 1000000000) {
    // getStockData is a time consuming process
    // we only get 2 years data
    const stockData = await getStockData(
      stockId,
      moment().year() - 2,
      moment().year(),
    );
    const lastTradingDate = (() => {
      const values = Object.values(stockData);
      return moment(values[values.length - 1].date);
    })();
    const lastStockData = stockData[moment(lastTradingDate).toISOString()];
    const abnormalVol = isAbnormalVolume(stockData);
    if (abnormalVol) {
      const tradingData3M = await getTradingData(
        stockId,
        lastStockData.open * 0.03,
        0.015,
        '3m',
      );
      const lastTradingDataInDay =
        tradingData3M[moment(lastTradingDate).toISOString()];
      if (lastTradingDataInDay != null && !lastTradingDataInDay.bigNegative) {
        const tradingData1D = await getTradingData(
          stockId,
          lastStockData.open * 0.03,
          0.015,
          '1d',
        );
        const activeRate = getActiveRate(tradingData1D);
        if (activeRate >= 0.2) {
          console.log(
            `Potential Stock Found: ${stockId}.HK@${
              lastTradingDataInDay.close
            }`,
          );
          const highestBigBuyTradingData = getHighestBuyTradingVolumeData(
            tradingData1D,
          );
          const highestBigSellTradingData = getHighestSellTradingVolumeData(
            tradingData1D,
          );

          const positive = lastTradingDataInDay.positive;
          const negative = lastTradingDataInDay.negative;
          const bigPositive = lastTradingDataInDay.bigPositive;
          const bigNegative = lastTradingDataInDay.bigNegative;
          const sanbaibing = lastTradingDataInDay.sanbaibing;
          const duobaibing = lastTradingDataInDay.duobaibing;
          const crossStar = lastTradingDataInDay.crossStar;
          const jumpyBuy = lastTradingDataInDay.jumpyBuy;

          return {
            highestBigBuyTradingData,
            highestBigSellTradingData,
            positive,
            negative,
            bigPositive,
            bigNegative,
            sanbaibing,
            duobaibing,
            jumpyBuy,
            crossStar,
            id: stockId.toString().padStart(5, '0'),
            name: profile.name,
            price: lastStockData.close,
            changePercent: lastStockData.change_percent,
            change: lastStockData.change,
            yield: profile.yield,
            hasYield: profile.yield > 0,
            active: activeRate > 0.5,
          } as StockSummary;
        }
      }
    }
  }
  return null;
}

async function sendHeaderToSlack(stockIds: string[], channel: string) {
  const slack = new Slack();
  slack.setWebhook(process.env.SLACK_WEBHOOK as string);
  const date = await getLastTradingDate();
  return new Promise((resolve, reject) => {
    slack.webhook(
      {
        channel,
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
                  `心水股: ${stockIds.map(s => `\`${s}\``).join(', ')}`,
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

async function sendStockToSlack(summary: StockSummary, channel: string) {
  // setup the slack
  const slack = new Slack();
  slack.setWebhook(process.env.SLACK_WEBHOOK as string);
  return new Promise((resolve, reject) => {
    slack.webhook(
      {
        channel,
        username: 'stockBot',
        attachments: [
          {
            color:
              summary.change === 0
                ? '#666'
                : summary.change > 0 ? '#00DD00' : '#DD0000',
            fields: [
              {
                value:
                  `
*${summary.name}* \`${summary.id}.HK\`
股價: \`${summary.price.toFixed(2)}\`
升幅 (百分率，股價): \`${summary.changePercent.toFixed(
                    2,
                  )}%\`, \`${summary.change.toFixed(2)}\`
最高買入成交量(分鐘) (時間, 成交量，平均價): ` +
                  '`' +
                  moment(summary.highestBigBuyTradingData.time).format(
                    'HH:mm',
                  ) +
                  '`, ' +
                  '`' +
                  summary.highestBigBuyTradingData.volume +
                  '`, ' +
                  '`' +
                  (
                    (summary.highestBigBuyTradingData.close -
                      summary.highestBigBuyTradingData.open) /
                      2 +
                    summary.highestBigBuyTradingData.open
                  ).toFixed(2) +
                  '`' +
                  `
最高賣出成交量(分鐘) (時間, 成交量, 平均價): ` +
                  '`' +
                  moment(summary.highestBigSellTradingData.time).format(
                    'HH:mm',
                  ) +
                  '`, ' +
                  '`' +
                  summary.highestBigSellTradingData.volume +
                  '`, ' +
                  '`' +
                  (
                    (summary.highestBigSellTradingData.close -
                      summary.highestBigSellTradingData.open) /
                      2 +
                    summary.highestBigSellTradingData.open
                  ).toFixed(2) +
                  '`\n' +
                  '最高買入成交量 ' +
                  (summary.highestBigBuyTradingData.volume >
                  summary.highestBigSellTradingData.volume
                    ? '>'
                    : '<') +
                  ' 最高賣出成交量' +
                  `
訊號: ${[
                    summary.bigPositive ? '`大陽燭`' : null,
                    !summary.bigPositive && summary.positive ? '`陽燭`' : null,
                    summary.hasYield ? '`有盈利`' : null,
                    summary.bigNegative ? '`大陰燭`' : null,
                    !summary.bigNegative && summary.negative ? '`陰燭`' : null,
                    summary.sanbaibing ? '`三白兵`' : null,
                    !summary.sanbaibing && summary.duobaibing
                      ? '`雙白兵`'
                      : null,
                    summary.crossStar ? '`十字星`' : null,
                    summary.jumpyBuy ? '`跳價高買`' : null,
                    summary.active ? '`活躍股`' : null,
                  ]
                    .filter(l => l)
                    .join(', ')}
`,
                short: false,
              },
            ],
            footer: `http://www.aastocks.com/tc/stock/DetailChart.aspx?symbol=${
              summary.id
            }`,
            image_url:
              `http://charts.aastocks.com/servlet/Charts?fontsize=12&15MinDelay=T` +
              `&lang=1&titlestyle=1&vol=1&Indicator=1&indpara1=10&indpara2=20&indpara3=50` +
              `&indpara4=100&indpara5=150&subChart1=12&ref1para1=0&` +
              `ref1para2=0&ref3para3=0&scheme=3&com=100&chartwidth=500&chartheight=500&` +
              `stockid=${summary.id.padStart(
                6,
                '0',
              )}.HK&period=5&type=1&logoStyle=1&`,
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

(async () => {
  if (process.env.SLACK_WEBHOOK == null) {
    console.error(
      'You need to setup SLACK_WEBHOOK variables in .env file first',
    );
    process.exit(1);
  }
  const stocks = await getStocks();
  const stockIds = Object.keys(stocks);
  // const stockIds = [
  //   1035, 1039, 1052, 1061, 1131, 1234, 1281,
  //   1513, 1660, 1862, 2200, 2222, 2877, 3313,
  //   3633, 6116, 28, 56, 116, 128, 144, 153,
  //   161, 180, 247, 281, 368, 464, 610, 709,
  //   867, 950,
  // ];
  // if call too frequently, may got banned
  const summaries = await Promise.all(
    stockIds.map(stockId => analyzeStock(+stockId)),
  );
  // const summaries = await Bluebird.mapSeries(stockIds, stockId => analyzeStock(+stockId));
  const filteredSummaries = summaries.filter(s => s) as StockSummary[];
  // console.log(filteredSummaries);
  // console.log(`${filteredSummaries.length} Stocks found!`);
  await sendHeaderToSlack(filteredSummaries.map(s => s.id), '#stock');
  await Bluebird.mapSeries(filteredSummaries, summary =>
    sendStockToSlack(summary, '#stock'),
  );
})();
