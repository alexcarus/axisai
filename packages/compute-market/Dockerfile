# Self-contained service — build with packages/compute-market as the context.
FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 4100
CMD ["node", "src/index.js"]
