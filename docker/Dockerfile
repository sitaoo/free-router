FROM node:20-slim
# The image mirrors the repo tree, so path resolution needs no env overrides:
# code in /srv/free-router/app, tracked defaults in .../app/config, and all
# writable runtime files in .../data (mounted as a volume in compose).
COPY . /srv/free-router
WORKDIR /srv/free-router/app
EXPOSE 8787
VOLUME ["/srv/free-router/data"]
CMD ["node", "server.mjs"]
