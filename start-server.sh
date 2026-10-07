#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Server can cai Node.js 20 tro len. Cai Node.js, sau do chay lai.' >&2
  exit 1
fi

if [ ! -f node_modules/dotenv/package.json ]; then
  printf '%s\n' 'Dang cai thu vien...'
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
fi

if [ ! -f .env ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  cp .env.example .env
  printf '%s\n' 'Da tao file .env mau. Dien OPENAI_API_KEY va PUBLIC_BASE_URL vao file .env.'
fi

node scripts/check-server.mjs
printf '%s\n' 'Mo /operator.html de dieu khien, /listen.html de nghe va hien phu de.'
printf '%s\n' 'Nhan Ctrl+C de dung server.'
exec node server.mjs
