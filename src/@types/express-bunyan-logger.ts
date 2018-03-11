declare module 'express-bunyan-logger' {
  import * as Bunyan from 'bunyan';
  import { RequestHandler, Request } from 'express';

  interface LoggerOptions {
    logger?: Bunyan;
    format?: string;
    parseUA?: boolean;
    levelFn?: (status: string, err: Error, meta: any) => string;
    includesFn?: string[];
    excludes?: string[];
    obfuscate?: string[];
    obfuscatePlaceholder?: string;
    serializers?: {
      req: Bunyan.Serializer;
      res: Bunyan.Serializer;
      err: Bunyan.Serializer;
    };
    immediate?: boolean;
    genReqId?(req: Request): string;
  }

  interface LoggerMiddleware {
    (options: LoggerOptions): RequestHandler;
  }

  const loggerMiddleware: LoggerMiddleware;
  export = loggerMiddleware;
}
