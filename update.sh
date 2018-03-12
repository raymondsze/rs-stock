#!/bin/bash

kill $(lsof -t -i:3000)
git pull
yarn install
yarn build
git add --all
git commit -m "update stock data"
git push
yarn stock &
yarn start
