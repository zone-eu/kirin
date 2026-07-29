FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    APPCONF_smtp_host=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js worker.js ./
COPY --chown=node:node config ./config
COPY --chown=node:node lib ./lib

EXPOSE 2525

USER node

CMD ["node", "server.js"]
