#!/bin/sh
set -e

# Makes the mounted volume writable, then drops privileges.
#
# The Dockerfile chowns /data at build time, but a platform volume is mounted
# over that directory at start — and the mount arrives owned by root. The image
# runs as `node`, so the app finds a directory it cannot write, reports
# `storage: unwritable`, and cannot even take the scheduler lease because taking
# it is itself a write.
#
# Nothing in the image can fix that at build time; it has to happen after the
# mount exists. So the container starts as root, fixes ownership, and immediately
# becomes `node` again — root is held for exactly one chown.

DATA_DIR="${VELTR_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Ignore failures: a read-only mount should surface through the health check
  # as `unwritable`, not as a container that refuses to start.
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec su node -s /bin/sh -c 'exec "$0" "$@"' -- "$@"
fi

exec "$@"
