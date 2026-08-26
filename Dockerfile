# Build stage for backend dependencies
FROM node:20-alpine AS build

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including production node_modules)
RUN npm ci --omit=dev

# Runner stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# Copy installed dependencies and source code
COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY src ./src
COPY scripts ./scripts

# Create uploads folder and set directory permissions
RUN mkdir -p uploads && chown -R node:node /app

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/api/v1/health || exit 1

CMD ["node", "src/server.js"]
