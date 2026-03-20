FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

# System deps: Xvfb, VNC, noVNC, browser libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify \
    curl ca-certificates \
    fonts-liberation fonts-noto-color-emoji \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libxcomposite1 libxdamage1 libxrandr2 libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps
COPY package.json ./
RUN npm install

# Install Playwright Chromium
RUN npx playwright install chromium --with-deps

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 6080 9222

ENTRYPOINT ["/app/entrypoint.sh"]
