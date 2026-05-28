# rubot shared packages

Three reusable libraries shared across all rubot services:

| Package | Lang | Purpose |
|---|---|---|
| `rubot-config` | Python | YAML + env config, `BaseAgent` pydantic_ai wrapper, `agent_log_v1` schema |
| `rubot-logger` | Python | Structured JSON envelope logging + FastAPI middleware + contextvars |
| `rubot-logger-ts` | TypeScript | TS mirror of rubot-logger for CF Workers (Hono middleware) |

## Install patterns

**Local development (recommended):** editable installs from this directory.

```bash
# from rubot/ root
./scripts/dev-setup.sh                       # both Python packages
./scripts/dev-setup.sh rubot-agent-template  # + a specific agent
```

**Docker build:** local path install at build time.

```dockerfile
COPY shared-packages/ ./shared-packages/
RUN pip install --no-cache-dir \
      ./shared-packages/packages/rubot-logger \
      ./shared-packages/packages/rubot-config
```

**Later: extract to a separate repo + git+https.** When the scaffold matures,
move this directory to its own private repo and switch Dockerfiles to:

```dockerfile
RUN --mount=type=secret,id=GITHUB_TOKEN,required=true \
    TOKEN=$(cat /run/secrets/GITHUB_TOKEN) && \
    pip install --no-cache-dir \
      "git+https://${TOKEN}@github.com/<org>/rubot-shared-packages.git#subdirectory=packages/rubot-config" \
      "git+https://${TOKEN}@github.com/<org>/rubot-shared-packages.git#subdirectory=packages/rubot-logger"
```

## TypeScript packages

`rubot-logger-ts` is consumed by Cloudflare Workers via the package.json:

```json
"@rubot/logger": "file:../../shared-packages/packages/rubot-logger-ts"
```

When extracted, switch to GitHub Packages or a private npm registry.
