FROM node:lts-slim AS BUILD
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run compile


FROM node:20.9.0-alpine3.18 AS PRODUCTION
WORKDIR /usr/src/app

COPY --from=BUILD --chown=node /usr/src/app .

ENTRYPOINT [ "npm", "run" ]
CMD [ "deploy-ufarmDocker-all" ]
