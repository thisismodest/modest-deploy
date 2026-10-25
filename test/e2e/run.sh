#!/bin/sh
# The end-to-end test: builds modest-host, starts a fresh Ubuntu server with systemd in
# Docker, and runs test/e2e/inside.ts in it. Needs Docker, and network access (for
# Node, Caddy, npm, and GitHub's published host keys).
#
#   sh test/e2e/run.sh            (add --keep to leave the server running afterwards)

set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
name=modest-host-e2e

docker build -q -t "$name" "$here" >/dev/null
(cd "$root" && npm run build --silent && npm pack --silent --pack-destination "$here" >/dev/null)
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock --add-host github.com:127.0.0.1 "$name" >/dev/null
trap '[ "${1:-}" = "--keep" ] || docker rm -f "$name" >/dev/null 2>&1; rm -f "$here"/modest-host-*.tgz' EXIT

until docker exec "$name" systemctl is-system-running 2>/dev/null | grep -qE "running|degraded"; do sleep 1; done
docker exec "$name" mkdir -p /e2e
docker cp "$here"/modest-host-0.0.0.tgz "$name":/e2e/modest-host.tgz
docker cp "$here/inside.ts" "$name":/e2e/inside.ts
docker cp "$here/product.js" "$name":/e2e/product.js
docker exec "$name" node /e2e/inside.ts
