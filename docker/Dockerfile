FROM node:20-slim
# The image mirrors the repo tree: code in /srv/free-router/app, tracked
# defaults in .../app/config. Runtime state stays at the repo root for now
# (see #11 for the planned data/ move).
COPY . /srv/free-router
WORKDIR /srv/free-router/app
EXPOSE 8787
CMD ["node", "server.mjs"]
