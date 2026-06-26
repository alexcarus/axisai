FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 5000
CMD ["sh", "-c", "node src/db/migrate.js && node src/index.js"]
