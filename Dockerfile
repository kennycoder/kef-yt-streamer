# syntax=docker/dockerfile:1
FROM node:22-alpine

# Install Python3, FFmpeg, and required tools for yt-dlp audio extraction
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    ca-certificates \
    curl \
    bash \
    && rm -rf /var/cache/apk/*

# Install the latest yt-dlp
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

# Set working directory
WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application source code
COPY . .

# Create volume directory for persistent data and pairing credentials
RUN mkdir -p /app/data && chmod 777 /app/data

# Expose ports for DIAL, HTTP Audio Streamer, and SSDP
EXPOSE 8098/tcp 8099/tcp 1900/udp

# Set environment defaults
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    YTDLP_PATH=yt-dlp \
    FFMPEG_PATH=ffmpeg

# Start bridge server
CMD ["node", "src/index.js"]
