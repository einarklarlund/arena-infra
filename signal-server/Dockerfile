# Must use slim instead of alpine for glibc, used by uWebSockets
FROM node:20-slim

# Install build essentials for uWebSockets.js native modules
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 9001
CMD ["node", "SignalServer.js"]