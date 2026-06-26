# Build from the REPOSITORY ROOT as build context:
#   docker build -f packages/whatsapp-agent/Dockerfile -t axis-whatsapp .
FROM node:20-alpine
WORKDIR /app

COPY package.json ./
COPY packages/shared ./packages/shared
COPY packages/whatsapp-agent ./packages/whatsapp-agent

RUN npm install --omit=dev --workspaces --include-workspace-root \
    --workspace @axis/shared --workspace @axis/whatsapp-agent

WORKDIR /app/packages/whatsapp-agent
ENV NODE_ENV=production
EXPOSE 8090
CMD ["node", "src/index.js"]
