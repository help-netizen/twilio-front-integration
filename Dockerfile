# Multi-stage build for React frontend + Node.js backend

# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

# Copy frontend package files
COPY frontend/package*.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy frontend source
COPY frontend/ ./

# Build frontend for production
RUN npm run build

# Stage 2: Build backend
FROM node:20-alpine AS backend

WORKDIR /app

# Copy backend package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy backend source from root src/ and backend/src/
COPY src/ ./src/
COPY backend/src/ ./backend/src/
COPY backend/db/ ./backend/db/
COPY migrate.js ./

# Copy frontend build from previous stage
COPY --from=frontend-builder /app/frontend/dist ./public

# Expose port
EXPOSE 3000

# Set production environment
ENV NODE_ENV=production

# Start the server
CMD ["node", "src/server.js"]
