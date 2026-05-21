FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src/ ./src/
CMD ["npx", "tsx", "src/tg-bot/index.ts"]
