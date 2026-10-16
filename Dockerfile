FROM node:20-alpine

WORKDIR /app

# Встановлюємо системні залежності для збірки better-sqlite3 та утиліту su-exec для безпечної зміни прав
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && apk add --no-cache libstdc++ su-exec

COPY package*.json ./

RUN npm install --omit=dev \
    && apk del .build-deps

COPY . .

# Копіюємо скрипт входу та робимо його виконуваним
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data

EXPOSE 8851 3000

VOLUME ["/app/data"]

ENV NODE_ENV=production

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]