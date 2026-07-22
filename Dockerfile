# Stage 1: Build the React frontend
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --silent
COPY frontend/ ./
RUN npm run build

# Stage 2: Python runtime — API + pipeline
FROM python:3.12-slim AS runtime
WORKDIR /app

# trafilatura uses lxml; the manylinux wheel bundles libxml2/libxslt so no
# extra apt packages are needed on amd64. Install build-essential only if you
# are building for arm64 and the lxml wheel is missing for your arch.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libxml2 libxslt1.1 \
    && rm -rf /var/lib/apt/lists/*

# Install Python package (deps declared in pyproject.toml)
COPY pyproject.toml ./
COPY harvester/ ./harvester/
RUN pip install --no-cache-dir -e .

# Static assets used at runtime
COPY prompts/ ./prompts/
COPY configs/ ./configs/

# Pre-built frontend (served as static files by the FastAPI app)
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# output/ and configs/ are mounted as volumes at runtime so the DB, digests,
# and profile overrides persist outside the container.
VOLUME ["/app/output"]

ENV PYTHONUNBUFFERED=1

EXPOSE 8001

CMD ["python", "-m", "harvester", \
     "--profile", "configs/profiles/daily-briefing.yaml", \
     "serve", "--host", "0.0.0.0", "--port", "8001"]
