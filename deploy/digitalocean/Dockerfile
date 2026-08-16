FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src

RUN mkdir -p /var/lib/gpulink \
    && chown node:node /var/lib/gpulink

USER node
EXPOSE 8088

CMD ["node", "src/control-plane/main.mjs"]
