# ToolTrace BiRefNet inference service — container for Railway (or any host).
# Build context is this server/ dir (set Railway "Root Directory" = server).
# The 224MB model is NOT in the image; it's fetched at startup from BIREFNET_MODEL_URL.
FROM node:22-slim

WORKDIR /app

# Install only the tracer deps. onnxruntime-node + sharp ship prebuilt linux-x64
# binaries, so no build toolchain is needed.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY trace-server.cjs ./

# Model lands here at startup (downloaded from BIREFNET_MODEL_URL). PORT is provided
# by the host (Railway injects $PORT); 8787 is the local default.
ENV BIREFNET_MODEL=/app/models/birefnet_lite.onnx
ENV PORT=8787
EXPOSE 8787

CMD ["node", "trace-server.cjs"]
