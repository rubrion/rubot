# syntax=docker/dockerfile:1.4
FROM python:3.11-slim

WORKDIR /app

COPY shared-packages/ ./shared-packages/
RUN pip install --no-cache-dir \
      ./shared-packages/packages/rubot-logger \
      ./shared-packages/packages/rubot-config

COPY agents/rubot-conversational/pyproject.toml .
RUN pip install --no-cache-dir .

COPY agents/rubot-conversational/ .

RUN chmod +x start.sh && \
    useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
CMD ["./start.sh"]
