FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache tini

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY db ./db
COPY public ./public
COPY templates ./templates

RUN mkdir -p data uploads && addgroup -S sgrhp && adduser -S sgrhp -G sgrhp \
 && chown -R sgrhp:sgrhp /app
USER sgrhp

ENV NODE_ENV=production PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://localhost:4000/health || exit 1

ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","src/server.js"]
