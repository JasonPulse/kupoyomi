# Kupoyomi. Owns series identity and the chapter ledger; talks to Suwayomi over
# GraphQL and to the manga share over a mounted volume. Needs no kubectl and no RBAC.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY db ./db
USER node
ENTRYPOINT ["node", "--enable-source-maps", "dist/index.js"]
CMD ["report"]
