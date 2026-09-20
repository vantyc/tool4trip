FROM node:22-alpine
WORKDIR /app

COPY trip-api/package.json ./trip-api/
WORKDIR /app/trip-api
RUN npm install --omit=dev && npm install tsx@4.20.5

WORKDIR /app
COPY shared ./shared
COPY trip-api/src ./trip-api/src

# shared/*.ts must resolve as ESM (nearest package.json) and find zod.
RUN printf '%s\n' '{"type":"module"}' > /app/package.json \
  && ln -sfn /app/trip-api/node_modules /app/node_modules

WORKDIR /app/trip-api
ENV NODE_ENV=production
ENV LISTEN_ADDR=:8080
USER node
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
