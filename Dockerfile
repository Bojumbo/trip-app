FROM node:20-alpine

# Встановлюємо залежності для збірки better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Порт для роботи додатку
EXPOSE 3000

# Том для постійного збереження бази даних
VOLUME ["/app/data"]

CMD ["node", "server.js"]