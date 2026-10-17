FROM node:20-alpine

WORKDIR /app

# Системні залежності для збірки better-sqlite3 + su-exec для зміни користувача
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && apk add --no-cache libstdc++ su-exec

COPY package*.json ./

# npm ci — відтворювана збірка за наявним package-lock.json
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && apk del .build-deps \
    && npm cache clean --force

COPY . .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data \
    && chown -R node:node /app

EXPOSE 3000

VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
