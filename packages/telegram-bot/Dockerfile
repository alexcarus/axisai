# Build from the REPOSITORY ROOT as build context so the local @axis/shared
# workspace dependency resolves:
#   docker build -f packages/telegram-bot/Dockerfile -t axis-telegram .
FROM node:20-alpine
WORKDIR /app

COPY package.json ./
COPY packages/shared ./packages/shared
COPY packages/telegram-bot ./packages/telegram-bot

# Install only the telegram-bot workspace (and its local @axis/shared link).
RUN npm install --omit=dev --workspaces --include-workspace-root \
    --workspace @axis/shared --workspace @axis/telegram-bot

WORKDIR /app/packages/telegram-bot
ENV NODE_ENV=production
CMD ["node", "src/index.js"]
