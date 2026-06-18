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

# Accept frontend config at build time (Vite embeds VITE_ vars at build)
ARG VITE_GOOGLE_MAPS_API_KEY
ARG VITE_FEATURE_AUTH_ENABLED
ARG VITE_KEYCLOAK_URL
ARG VITE_KEYCLOAK_REALM
ARG VITE_KEYCLOAK_CLIENT_ID
ARG VITE_STRIPE_PUBLISHABLE_KEY
ENV VITE_GOOGLE_MAPS_API_KEY=$VITE_GOOGLE_MAPS_API_KEY
ENV VITE_FEATURE_AUTH_ENABLED=$VITE_FEATURE_AUTH_ENABLED
ENV VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL
ENV VITE_KEYCLOAK_REALM=$VITE_KEYCLOAK_REALM
ENV VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID
ENV VITE_STRIPE_PUBLISHABLE_KEY=$VITE_STRIPE_PUBLISHABLE_KEY

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
COPY scripts/ ./scripts/

# Copy frontend build from previous stage
COPY --from=frontend-builder /app/frontend/dist ./public

# Expose port
EXPOSE 3000

# Set production environment
ENV NODE_ENV=production

# Start the server
CMD ["node", "src/server.js"]
