# Ephemeral smoke-test fixture only. Not a production base-image recommendation.
FROM node:22-alpine
ARG FIXTURE_VERSION=v1
ENV FIXTURE_VERSION=$FIXTURE_VERSION
WORKDIR /fixture
COPY server.mjs ./server.mjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=1s --timeout=2s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(async r=>{if(!r.ok)process.exit(1);const v=await r.json();if(!v.ok||!v.fixture||v.service!==process.env.SERVICE||v.version!==process.env.FIXTURE_VERSION)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
