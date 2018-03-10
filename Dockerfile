FROM node:8
LABEL maintainer="szer0601@gmail.com"

ENV CI true
ENV NODE_ENV production

# copy all source
WORKDIR /server
COPY . /server

# install yarn package management so we can take benefit of yarn.lock
RUN npm install -g yarn
# install all required modules, the build step is inside postinstall
# --production=false to force install devDependencies
RUN yarn install --production=false
# expose 3000 port
# EXPOSE 3000

CMD yarn env && yarn start
