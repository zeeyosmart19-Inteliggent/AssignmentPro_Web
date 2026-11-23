FROM node:22-alpine
WORKDIR /app
COPY server.mjs engine.mjs index.html package.json ./
ENV PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "server.mjs"]
