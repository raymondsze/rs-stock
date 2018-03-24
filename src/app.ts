import * as bodyParser from 'body-parser';
import * as bunyan from 'bunyan';
import * as express from 'express';
import * as loggerMiddleware from 'express-bunyan-logger';
import * as helmet from 'helmet';
import * as _ from 'lodash';
import * as uuid from 'uuid';
import { analyzeStock, sendStockToSlack } from './stock';
import * as Bluebird from 'bluebird';
import * as moment from 'moment';

const logLevel: bunyan.LogLevel = _.defaultTo(
  process.env.LOG_LEVEL,
  bunyan.INFO,
) as bunyan.LogLevel;

// create the bunyan logger which log message as json format
export const logger = bunyan.createLogger({
  name: 'rs-stock',
  serializers: bunyan.stdSerializers,
});

// setup the bunyan level
logger.level(logLevel);

const app = express();
// enable the application to obtain the correct ip address
// even behind proxy like nginx
app.enable('trust proxy');
// security guard
app.use(helmet());
// use bunyan logger
app.use(
  loggerMiddleware({
    logger,
    genReqId: req =>
      _.defaultTo(req.headers['x-request-id'] as string, uuid.v4()),
    obfuscate: ['req.headers.authorization'],
  }),
);
// parse body if content-type is json
app.use(bodyParser.json());
// parse body if content-type is url encoded
app.use(bodyParser.urlencoded({ extended: false }));

// analyze
app.post('/analyze', async (req, res) => {
  try {
    const { text, channel_name } = req.body;
    if (channel_name !== 'general' && channel_name !== 'stock') {
      res.json({ text: '請於 #general 或 #stock 跟我說話...' });
      return;
    }
    const stockNumbers = _.defaultTo(text, '').split(' ') as string[];
    const date = stockNumbers.find(d => d.match(/\d{8}/) !== null);
    // background job
    (async () => {
      const summaries = await Bluebird.mapSeries(
        stockNumbers.filter(d => !d.match(/\d{8}/)),
        (stockNumber: any) => {
          if (date != null) return analyzeStock(+stockNumber, true, moment(date, 'YYYYMMDD').toDate());
          else return analyzeStock(+stockNumber, true);
        }
      );
      await Bluebird.mapSeries(
        summaries.filter(d => d), summary => sendStockToSlack(summary as any, '#stock'));
    })();
    res.json({ text: '收到！宜家即刻幫你分析！' });
  } catch (e) {
    console.error(e);
    res.json({ text: '程式發生錯誤...' });
  }
});

// analze all stock
// app.post('/analyzeAll', async (req, res) => {
//   try {
//     const { channel_name } = req.body;
//     if (channel_name !== 'general' && channel_name !== 'stock') {
//       res.json({ text: '請於 #general 或 #stock 跟我說話...' });
//       return;
//     }
//     spawn('node', [path.join(__dirname, 'stocks.js')]);
//     res.json({ text: '收到！宜家即刻幫你分析！' });
//   } catch (e) {
//     console.error(e);
//     res.json({ text: '程式發生錯誤...' });
//   }
// });

app.listen(process.env.PORT, (err: Error) => {
  if (err != null) {
    logger.error(err);
  }
  logger.info(
    `Server is now running on ` +
    `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}`);
});

// integrate bunyan error logging when uncaught exception
process.on('uncaughtException', (err: Error) => {
  logger.error(err);
  process.exit(1);
});

// import { analyzeAllStocks } from './stock';

// analyzeAllStocks();
