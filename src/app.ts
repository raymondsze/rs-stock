import * as bodyParser from 'body-parser';
import * as bunyan from 'bunyan';
import * as express from 'express';
import * as loggerMiddleware from 'express-bunyan-logger';
import * as helmet from 'helmet';
import * as _ from 'lodash';
import * as qs from 'qs';
import * as uuid from 'uuid';
import {
  summarizeStock,
  summarizeAllStocks,
} from './stock';

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
app.post('/analyze', async (req, res, next) => {
  try {
    const { text } = qs.parse(req.body);
    const stockIds = (text || '').split(' ') as string[];
    await Promise.all(stockIds.map(stockId => summarizeStock(+stockId)));
  } catch (e) {
    console.error(e);
    next(e);
  }
});

// analze all stock
app.post('/analyzeAll', async (req, res, next) => {
  try {
    await summarizeAllStocks();
  } catch (e) {
    console.error(e);
    next(e);
  }
});

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
