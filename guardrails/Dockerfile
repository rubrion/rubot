# syntax=docker/dockerfile:1.4
FROM python:3.11-slim

WORKDIR /app

# Install shared packages from the local scaffold.
# Build context must be the rubot/ root, not the guardrails dir.
COPY shared-packages/ ./shared-packages/
RUN pip install --no-cache-dir \
      ./shared-packages/packages/rubot-logger \
      ./shared-packages/packages/rubot-config

COPY guardrails/pyproject.toml .
RUN pip install --no-cache-dir .

COPY guardrails/ .

RUN chmod +x start.sh && \
    useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
CMD ["./start.sh"]
