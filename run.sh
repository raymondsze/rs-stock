#!/bin/bash

git pull
yarn install
yarn stock
git add
git commit -m "update stock data"
git push
