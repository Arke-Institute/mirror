# Use Node.js 20 Alpine for minimal image size
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Create data directory for volume mount
RUN mkdir -p /data

# Set default environment variables
ENV NODE_ENV=production
ENV STATE_FILE_PATH=/data/mirror-state.json

# Run the application
CMD ["node", "--enable-source-maps", "dist/mirror.js"]
