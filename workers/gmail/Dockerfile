FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY poller.mjs ./
COPY reply.mjs ./
COPY apps-script.mjs ./
COPY sender-names.mjs ./
USER node
CMD ["node", "poller.mjs"]
