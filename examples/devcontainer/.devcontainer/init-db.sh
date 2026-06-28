#!/usr/bin/env bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT 'CREATE DATABASE shadow'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'shadow')\gexec
SQL
