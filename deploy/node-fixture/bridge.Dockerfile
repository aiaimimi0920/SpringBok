FROM node:22-alpine
WORKDIR /app
COPY cloud ./cloud
COPY src ./src
COPY scripts/node-fixture.mjs ./scripts/node-fixture.mjs
CMD ["node", "scripts/node-fixture.mjs"]
