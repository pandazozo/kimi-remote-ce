FROM node:20-alpine
WORKDIR /app

COPY gateway/package*.json ./
RUN npm ci --omit=dev

COPY gateway/src ./src
COPY web ./web
COPY agent ./agent

ENV WEB_DIR=/app/web
ENV AGENT_DIR=/app/agent
EXPOSE 8080
CMD ["node", "src/index.js"]
