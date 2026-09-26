#!/usr/bin/env bash
# Builds and starts the manager for the local stack (docker-compose.local.yml).
# Extra arguments go to `docker compose`, e.g. `scripts/local/up.sh logs -f api`.
set -euo pipefail
cd "$(dirname "$0")/../.."

[ -f .env.local ] || { echo "no .env.local; run scripts/local/register-node.sh first" >&2; exit 1; }

compose() {
  docker compose --env-file .env.local \
    -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.local.yml "$@"
}

if [ $# -gt 0 ]; then
  compose "$@"
  exit
fi

image="$(grep '^OBS_INSTANCE_IMAGE=' .env.local | cut -d= -f2-)"
if [ -n "$image" ] && ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "instance image $image not found; build it in the obs-cloud-selkies repo (docker compose build)" >&2
  exit 1
fi

compose up -d --build api
echo "manager: http://localhost:$(grep '^API_HOST_PORT=' .env.local | cut -d= -f2-)/health"
