FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# WB_API_TOKEN необязателен: без него работают все инструменты аналитики товаров
ENTRYPOINT ["node", "src/index.js"]
