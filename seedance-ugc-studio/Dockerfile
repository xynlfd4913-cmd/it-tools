FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js business.js ./
COPY public ./public
RUN mkdir -p /app/public/generated /app/.runtime && chown -R node:node /app/public/generated /app/.runtime

ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
