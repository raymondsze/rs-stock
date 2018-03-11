#!/bin/bash

kill $(lsof -t -i:3000)
git pull
yarn install
yarn build
# yarn stock
git add
git commit -m "update stock data"
git push
yarn start
