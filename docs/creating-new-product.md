# Creating a new product from the scaffold

There are two scopes of "new thing" on rubot:

- **A new specialist agent inside an existing app** — `cp -r` the
  template into `agents/`, register it. See
  [`creating-new-agent.md`](creating-new-agent.md). Stay in one repo.
- **A whole new product** — a distinct application (its own agents,
  domain data model, dashboard surface, deploy targets) that happens to
  build on the rubot plumbing. This becomes its **own repo, forked from
  rubot**. That's what this doc covers.

The rule of thumb: if the work edits the scaffold's own services
(middleware schema, dashboard pages, orchestrator config) and adds
several agents around one domain, it's a product — fork it. rubot stays
generic and only **advertises** the products built on it; it never
carries product code.

`brad` (a marketing-consultant suite) is the reference example.

---

## Why a fork, not a folder

An earlier attempt kept the product under `products/<name>/`. It doesn't
hold up: product code never stays contained there. Brand-kit storage,
image routes, and dashboard pages live **in-place** inside
`rubot-middleware` / `rubot-client`, so `products/<name>/` ends up being
half the product pretending to be all of it.

A fork is honest: the entire repo *is* the product. Agents are siblings
of the template under `agents/`; shared helpers are a normal package
under `shared-packages/packages/`. Pull scaffold improvements down from
rubot via an upstream remote; never push product specifics back up.

---

## Step 1 — branch the scaffold improvements you want first

If your product needs changes that are genuinely **generic** (a new
shared util, a logging tweak, a bug fix), make those in rubot itself and
commit them there *before* forking — so every future product inherits
them. Only domain-specific work goes in the fork.

---

## Step 2 — create the product repo and re-point remotes

Create the new repo on your host (private or public), then in a fresh
clone (or your working scaffold checkout):

```bash
# keep rubot reachable as upstream, point origin at the new product repo
git remote rename origin rubot
git remote add origin https://github.com/<org>/<product>.git
```

Now `rubot` is upstream (pull scaffold fixes) and `origin` is the
product. This preserves shared history, so `git pull rubot main` keeps
working.

> If you'd rather start the product's history clean (no shared commits),
> `rm -rf .git && git init` instead — but you lose easy upstream pulls.
> The shared-history fork is recommended.

---

## Step 3 — build the product

Typical shape (what brad did):

- **Agents** — `cp -r agents/rubot-agent-template agents/<product>-<role>`
  for each specialist. Edit prompt, tools, `_CAPABILITIES`, pyproject
  name, Dockerfile COPY paths. See [`creating-new-agent.md`](creating-new-agent.md).
- **Shared helpers** — a package under
  `shared-packages/packages/<product>-shared/` (mirror `rubot-config`'s
  `pyproject.toml`). Add its editable install to `scripts/dev-setup.sh`.
  Keep it tenant-neutral.
- **Data model** — append tables to
  `workers/rubot-middleware/schema.sql`; add CRUD + data routes under
  `src/routes/`; mount them in `src/index.ts` on the existing auth
  chains.
- **Dashboard** — add pages under
  `workers/rubot-client/src/pages/dashboard/[tenantId]/` and a tab in
  `TenantNav`. The `/api/proxy` passthrough needs no change.
- **Orchestrator** — extend `AGENT_REGISTRY_JSON` (env) with the new
  agent URLs. If an agent is routable without a data provider, add its
  id to `_PROVIDER_INDEPENDENT_SOURCES` in `router.py`. Add the ids to
  `KNOWN_AGENTS_JSON` in the middleware `wrangler.jsonc` so the per-tenant
  toggle lists them.
- **Trim scaffold demos** — a product fork can delete the teaching
  pieces it doesn't use (`rubot-open-client`, `rubot-conversational`,
  `providers/example-provider`). Rewire anything that referenced them
  (`router.py`, `data.ts KNOWN_PROVIDERS`). **Do this in the fork only**
  — rubot keeps its demos; they teach the scaffold.

---

## Step 4 — commit and push the product

```bash
git add -A
git commit -m "Fork rubot → <product>: <one-line scope>"
git push -u origin main
```

Later, to absorb scaffold improvements:

```bash
git pull rubot main   # resolve conflicts toward product-specific files
```

---

## Step 5 — advertise on rubot

Back in the **rubot** repo (separate checkout), add a one-line entry so
the scaffold points at the product:

- `OVERVIEW.md` — a row in the **Built with rubot** table (name, blurb,
  repo link or "private").
- `README.md` — a bullet under **Built with rubot**.

rubot carries *only* the advert — no product docs, no product code. If
the product repo is private, say "private" instead of linking.

---

## Checklist

- [ ] Generic improvements committed to rubot first (Step 1).
- [ ] Product repo created; `origin` → product, `rubot` → upstream.
- [ ] Agents forked from the template; `<product>-shared` package +
      `dev-setup.sh` entry.
- [ ] Data model, dashboard, orchestrator config wired.
- [ ] Scaffold demos trimmed in the fork (rubot keeps them).
- [ ] Product committed + pushed to its own `origin`.
- [ ] One-line advert added in rubot's `OVERVIEW.md` + `README.md`.
- [ ] `git pull rubot main` verified working for future upstream syncs.
