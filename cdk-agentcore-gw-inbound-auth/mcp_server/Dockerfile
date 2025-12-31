FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app

# All environment variables in one layer
ENV UV_SYSTEM_PYTHON=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_PROGRESS=1 \
    PYTHONUNBUFFERED=1 \
    DOCKER_CONTAINER=1 \
    AWS_REGION=us-east-1 \
    AWS_DEFAULT_REGION=us-east-1 \
    PYTHON=/usr/local/bin/python3

COPY . .
# Install from pyproject.toml directory
RUN uv sync --frozen --no-cache

# Create non-root user
RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

EXPOSE 8000

# Use the full module path
CMD ["uv", "run", "opentelemetry-instrument", "uv", "run", "src/mcp_server.py"]
