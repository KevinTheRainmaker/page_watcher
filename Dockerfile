FROM node:20-alpine

WORKDIR /app

COPY push-server/package*.json ./
RUN npm ci --omit=dev

COPY push-server/ ./

ENV NODE_ENV=production

CMD ["npm", "start"]
