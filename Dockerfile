FROM node:20-alpine

WORKDIR /app

# Install ffmpeg for audio format conversion (WebM → WAV for VAD silence stripping)
RUN apk add --no-cache ffmpeg

# Copy package files and install production deps only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy server source and required assets
COPY server/ ./server/
COPY .env.example ./.env.example

# Create uploads directory
RUN mkdir -p /app/uploads

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "server/index.js"]
