# Railway recorder: League Plus + Zoom Football + Zoom Tennis, publishing to this repo's `data` branch
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY recorder/package.json recorder/package-lock.json recorder/
RUN cd recorder && npm ci --omit=dev --no-audit --no-fund
COPY docs docs
COPY recorder/run.js recorder/
ENV DATA_DIR=/tmp/data RECORDER_HOST=railway
# runs 12 h, then exits; Railway restarts it straight away (keeps memory use low)
CMD ["node", "recorder/run.js", "--minutes", "720"]
