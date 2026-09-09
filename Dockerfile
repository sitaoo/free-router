FROM node:20-slim
WORKDIR /app
COPY . /app
EXPOSE 8787
CMD ["node", "server.mjs"]
