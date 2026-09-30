# Ephemeral smoke-test fixture only. Not a production base-image recommendation.
FROM node:22-alpine
WORKDIR /fixture
COPY server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
