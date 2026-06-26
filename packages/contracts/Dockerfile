FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npx hardhat compile
EXPOSE 8545
# Run a local development chain reachable from other containers.
CMD ["npx", "hardhat", "node", "--hostname", "0.0.0.0"]
