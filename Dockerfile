FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/app.db PORT=3000
COPY package.json ./
COPY src ./src
COPY web ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
