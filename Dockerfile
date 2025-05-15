FROM python:3.12-slim

# ── 1. Install Calibre CLI only ────────────────────────────────────────
RUN apt-get update && \
    apt-get install -y --no-install-recommends wget xz-utils fonts-dejavu-core libegl1 libopengl0 libxcb-cursor0 libfreetype6-dev libnss3 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxtst6 libfontconfig1 libxkbcommon0 libasound2 libxkbfile1 libglx0 libgl1-mesa-glx libgl1-mesa-dri libssl3 mesa-vulkan-drivers libglu1-mesa && \
    wget -nv -O- https://download.calibre-ebook.com/linux-installer.sh | sh /dev/stdin install_dir=/usr/local isolated=y && \
    apt-get purge -y wget xz-utils && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Add Calibre to PATH
ENV PATH="/usr/local/calibre/bin:${PATH}"
ENV LD_LIBRARY_PATH="/usr/local/calibre/lib:${LD_LIBRARY_PATH}"


# Tell Qt to skip HW detection and use software rendering
ENV QT_OPENGL=software
# Disable QtWebEngine sandbox (already set for Chromium, this is Qt's side)
ENV QTWEBENGINE_DISABLE_SANDBOX=1
# Point to custom OpenSSL config and modules
ENV OPENSSL_CONF=/etc/ssl/openssl.cnf
ENV OPENSSL_MODULES=/usr/lib/x86_64-linux-gnu/ossl-modules

# Pass --no-sandbox to QtWebEngine/Chromium and disable GPU
ENV QTWEBENGINE_CHROMIUM_FLAGS="--no-sandbox --disable-gpu"

# Qt/WebEngine: silence GPU complaints (optional)
ENV QT_QPA_PLATFORM=offscreen
ENV QT_QUICK_BACKEND=software
ENV LIBGL_ALWAYS_SOFTWARE=1

# Configure OpenSSL to load legacy providers by replacing the default openssl.cnf
COPY custom-openssl.cnf /etc/ssl/openssl.cnf

# ── 2. Node runtime ────────────────────────────────────────────────────
# Install Node.js LTS
RUN export LD_LIBRARY_PATH="" && \
    apt-get update && \
    apt-get install -y curl ghostscript && \
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# RUN corepack enable && corepack prepare pnpm@9.1.0 --activate # Switched to npm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","server.js"] 