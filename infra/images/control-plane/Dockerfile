FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

ARG GPULINK_RELEASE_REVISION=development
ARG GPULINK_RELEASE_TAG=local

LABEL org.opencontainers.image.title="GPULink Control Plane" \
      org.opencontainers.image.source="https://github.com/JCrossoverGithub/GPULink" \
      org.opencontainers.image.revision="${GPULINK_RELEASE_REVISION}" \
      org.opencontainers.image.version="${GPULINK_RELEASE_TAG}"

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci \
      --omit=dev \
      --ignore-scripts \
      --no-audit \
      --no-fund \
    && npm cache clean --force \
    && test "$(id -u node)" = "1000" \
    && test "$(id -g node)" = "1000"

COPY src ./src

USER 1000:1000

EXPOSE 8088

CMD ["node", "src/control-plane/main.mjs"]
