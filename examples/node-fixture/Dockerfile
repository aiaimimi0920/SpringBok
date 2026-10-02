FROM node:22-alpine
ARG FIXTURE_VERSION=v1
ENV FIXTURE_VERSION=$FIXTURE_VERSION
WORKDIR /fixture
COPY server.mjs health.mjs ./
RUN mkdir /data && chown node:node /data
USER node
HEALTHCHECK --interval=2s --timeout=2s --retries=3 CMD ["node", "health.mjs"]
CMD ["node", "server.mjs"]
