# Docker workflow

Two ways to run this app in Docker. Pick one per machine.

| | **A — Pull the published image** | **B — Build from git** |
|---|---|---|
| Use for | Another PC, or this Mac when you want the last **release** | The Mac where you write code, before you publish |
| Needs | Docker only (and git to clone compose) | Git + Docker |
| Command | `docker compose pull` then `up -d` | `git pull` then `up -d --build` |

The image is `ghcr.io/nicolas-cilia/backoffice-printing`. It is **public** and linked to this repo. Other machines do **not** need `docker login` to pull. The machine that **publishes** still logs in to `ghcr.io` with a token that has `write:packages`.

Compose publishes host port **8484** → container **8000** (Docker Desktop). Leave `network_mode: host` commented on Mac/Windows. Add printers by IP. Open http://localhost:8484 (on another phone: `http://<that-PC-LAN-IP>:8484`).

To pick a different host port without rebuilding: put `HOST_PORT=9123` (or whatever) in `.env` next to `docker-compose.yml`, then `docker compose up -d`. Do **not** set `PORT=` for this — that is the listen port *inside* the container and must stay `8000` unless you also change the right-hand side of the `ports:` mapping.

---

## 1. Install on a machine (published image)

```bash
git clone https://github.com/Nicolas-Cilia/Backoffice-Printing.git
cd Backoffice-Printing
docker compose pull
docker compose up -d
```

Do **not** pass `--build` here. That compiles local git instead of using GHCR.

### Already installed — change the browser port

You do **not** need a new image or `docker compose pull`. The published package always listens on **8000 inside** the container. Only the host mapping changes.

On that machine, in the clone next to `docker-compose.yml`:

```bash
# pick any free host port; 8484 is the repo default
echo 'HOST_PORT=8484' >> .env
docker compose up -d
```

Then open `http://localhost:8484` (or that PC’s LAN IP on that port). Old bookmarks to `:8000` will stop working.

If compose on that machine is still the old `"${PORT:-8000}:8000"` line, either `git pull origin main` first, or edit the left-hand number in `ports:` to `"8484:8000"` and run `docker compose up -d`. Do not set `PORT=8484` in `.env` with that old mapping — it would make the app listen on 8484 inside while Docker still forwards to container 8000.

When a new image has been published:

```bash
cd Backoffice-Printing
git pull origin main    # only needed if compose/docs changed
docker compose pull
docker compose up -d
```

---

## 2. Publish a new image (from `main`)

Do this on the Mac that has Docker login to GHCR, after the code you want in the image is on **`origin/main`**.

1. Merge/PRs so `main` is what you want to ship.
2. **Bump the version** (see below) and push that commit to `main`.
3. Checkout `main` and pull:

```bash
cd /path/to/Backoffice-Printing
git checkout main
git pull origin main
grep APP_VERSION backend/app/core/config.py
```

4. Publish. Use the **same** number as `APP_VERSION`. `--ghcr-only` skips Docker Hub.

```bash
./docker-publish.sh 1.0.1 --ghcr-only
```

That pushes `ghcr.io/nicolas-cilia/backoffice-printing:1.0.1` and, for a non-beta tag, also `:latest`.

5. Confirm:

```bash
docker manifest inspect ghcr.io/nicolas-cilia/backoffice-printing:1.0.1
```

You should see `linux/amd64` and `linux/arm64`.

You do **not** re-link the package to the repo or change public/private after each publish. New tags attach to the existing package.

Beta tags end in `b` (example `1.1.0b`) and do **not** move `:latest`.

---

## 3. Where to update the version number

**One place in code:** `backend/app/core/config.py`. Frontend `package.json` is **not** the app version.

```python
APP_VERSION = "1.0.0"
```

Sidebar and Settings read this via `GET /updates/version`.

**Same string** goes on the publish command:

```bash
./docker-publish.sh 1.0.0 --ghcr-only
```

| Number | Bump when |
|--------|-----------|
| **Patch** `1.0.0` → `1.0.1` | Fix, small safe change |
| **Minor** `1.0.0` → `1.1.0` | New feature; old installs still run |
| **Major** `1.0.0` → `2.0.0` | Breaking run/data change |

Workflow: change `APP_VERSION` → commit/PR to `main` → `./docker-publish.sh <that-version> --ghcr-only`. If you publish without bumping `APP_VERSION`, the image tag and the sidebar will disagree.

A machine that only `git pull`s does **not** change the in-app version until it either `--build`s that commit or `pull`s a newly published image.

---

## This Mac, day to day

Coding: `git pull` (or your feature branch) then `docker compose up -d --build`.

Shipping: bump `APP_VERSION`, merge to `main`, publish, then any machine (including this one) can `docker compose pull && docker compose up -d` to run the release.
