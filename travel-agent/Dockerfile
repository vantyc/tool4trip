FROM node:22-alpine
WORKDIR /app
COPY travel-agent/package.json ./
RUN npm install --omit=dev && npm install tsx@4.20.5
COPY shared ./shared
COPY travel-agent/src ./src
ENV NODE_ENV=production
ENV LISTEN_ADDR=:8080
USER node
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
