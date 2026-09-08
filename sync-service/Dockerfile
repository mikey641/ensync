# Self-hosted Ensync Sync service.
#
# The service has no runtime dependencies beyond Node.js built-ins, so this
# image copies only the service directory. Persistent account + workspace data
# is expected at the mounted /data path.

FROM node:22-alpine

ENV NODE_ENV=production \
    ENSYNC_SYNC_HOST=0.0.0.0 \
    ENSYNC_SYNC_PORT=8080 \
    ENSYNC_SYNC_DATA_FILE=/data/ensync-sync.json

WORKDIR /app
COPY sync-service ./sync-service

EXPOSE 8080
VOLUME ["/data"]

CMD ["node", "sync-service/server.mjs"]
