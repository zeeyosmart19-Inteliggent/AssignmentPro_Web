FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs engine.mjs pg-api.mjs index.html ./
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.mjs"]
