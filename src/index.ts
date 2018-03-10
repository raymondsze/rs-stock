// https://github.com/bkeepers/dotenv#what-other-env-files-can-i-use
/* tslint:disable */
require('source-map-support').install();

const fs = require('fs');
const path = require('path');
const _ = require('lodash');

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

require('./module');
require('./app');
