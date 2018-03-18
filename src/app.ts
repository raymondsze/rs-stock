import * as bodyParser from 'body-parser';
import * as bunyan from 'bunyan';
import * as express from 'express';
import * as loggerMiddleware from 'express-bunyan-logger';
import * as helmet from 'helmet';
import * as _ from 'lodash';
import * as uuid from 'uuid';
import * as path from 'path';
import { spawn } from 'child_process';

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
    // background job
    const exec = spawn('node', [path.join(__dirname, 'stock.js'), ...stockNumbers]);
    exec.stdout.on('data', (data) => {
      console.log(`${data.toString()}`);
    });
    exec.stderr.on('data', (data) => {
      console.error(`${data.toString()}`);
    });
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
