FROM node:24.16-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY hardhat.config.ts tsconfig.json ./
COPY hardhat ./hardhat
COPY contracts ./contracts
COPY scripts ./scripts
COPY ignition ./ignition
COPY artifacts ./artifacts

ENTRYPOINT ["npm", "run"]
CMD ["idle"]
