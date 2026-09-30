FROM node:22-alpine
WORKDIR /integration
COPY src ./src
COPY scripts/integration/driver.mjs ./scripts/integration/driver.mjs
USER node
CMD ["node", "scripts/integration/driver.mjs"]
