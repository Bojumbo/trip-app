FROM node:20-alpine

WORKDIR /app

# Встановлюємо системні залежності для збірки better-sqlite3
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && apk add --no-cache libstdc++

COPY package*.json ./

RUN npm install --omit=dev \
    && apk del .build-deps

COPY . .

# Створюємо директорію для даних та надаємо права безпечному користувачу node
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000

VOLUME ["/app/data"]

ENV NODE_ENV=production

CMD ["node", "server.js"]