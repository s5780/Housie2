FROM node:20-bookworm
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/housie.db
RUN mkdir -p /data
EXPOSE 3000
CMD ["node","server.js"]
