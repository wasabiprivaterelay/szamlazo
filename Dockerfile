# The server image, built from the repository root:
#   docker build -t szamlazo .
# Two stages: the first compiles everything, the second holds only what runs.

FROM node:26-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/invoicing/package.json packages/invoicing/
COPY packages/nav/package.json packages/nav/
COPY packages/server/package.json packages/server/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages packages
RUN npm run build

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/invoicing/package.json packages/invoicing/
COPY packages/nav/package.json packages/nav/
COPY packages/server/package.json packages/server/
# Only what the server needs at run time; no compilers, no test tools.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace @szamlazo/server \
  && npm cache clean --force
COPY --from=build /repo/packages/invoicing/dist packages/invoicing/dist
COPY --from=build /repo/packages/nav/dist packages/nav/dist
COPY --from=build /repo/packages/server/dist packages/server/dist
COPY packages/server/migrations packages/server/migrations
# The folder for invoice PDFs when STORAGE=local; mount a volume here.
RUN mkdir -p /data/invoices && chown node:node /data/invoices
USER node
WORKDIR /app/packages/server
ENV HOST=0.0.0.0 \
    PORT=3000 \
    STORAGE_DIR=/data/invoices
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/index.js"]
