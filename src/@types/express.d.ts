import * as Bunyan from 'bunyan';

declare global {
  namespace Express {
    export interface Request {
      log: Bunyan;
    }
  }
}
