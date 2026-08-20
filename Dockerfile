FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY types ./types

RUN npm run build

FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    APPCONF_smtp_host=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node config ./config

EXPOSE 2525

USER node

ENTRYPOINT ["node", "--enable-source-maps", "dist/esm/server.js"]
