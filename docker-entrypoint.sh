#!/bin/sh
set -e

# Автоматично виправляємо права доступу на змонтований том для безпечного користувача node
mkdir -p /app/data
chown -R node:node /app/data
chmod 775 /app/data

# Запускаємо додаток від імені користувача node
exec su-exec node "$@"
