# ToolTrace tracer — Hugging Face Space (Docker SDK).
# Put this + trace-server.cjs + package.json + README.md at the Space repo ROOT.
# HF routes to port 7860 by convention, so we listen there.
FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY trace-server.cjs ./

# Model is fetched at startup from BIREFNET_MODEL_URL (set as a Space secret).
ENV BIREFNET_MODEL=/app/models/birefnet_lite.onnx
ENV PORT=7860
EXPOSE 7860

CMD ["node", "trace-server.cjs"]
