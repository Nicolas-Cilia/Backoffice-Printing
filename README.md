<p align="center">
  <img src="static/img/backoffice_printing_logo.png" alt="Backoffice Printing Logo" width="300">
</p>

<h1 align="center">Backoffice Printing</h1>

<p align="center">
  <strong>Self-hosted shop-floor control for a local Bambu Lab print setup.</strong>
</p>

<p align="center">
  <a href="https://github.com/Nicolas-Cilia/Backoffice-Printing/releases"><img src="https://img.shields.io/github/v/release/Nicolas-Cilia/Backoffice-Printing?style=flat-square&color=blue&cacheSeconds=3600" alt="Release"></a>
  <img src="https://github.com/Nicolas-Cilia/Backoffice-Printing/actions/workflows/ci.yml/badge.svg?branch=main">
  <img src="https://github.com/Nicolas-Cilia/Backoffice-Printing/actions/workflows/github-code-scanning/codeql/badge.svg">
  <img src="https://github.com/Nicolas-Cilia/Backoffice-Printing/actions/workflows/security.yml/badge.svg">
  <a href="https://github.com/Nicolas-Cilia/Backoffice-Printing/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Nicolas-Cilia/Backoffice-Printing?style=flat-square&cacheSeconds=3600" alt="License"></a>
  <a href="https://github.com/Nicolas-Cilia/Backoffice-Printing/stargazers"><img src="https://img.shields.io/github/stars/Nicolas-Cilia/Backoffice-Printing?style=flat-square&cacheSeconds=3600" alt="Stars"></a>
  <a href="https://github.com/Nicolas-Cilia/Backoffice-Printing/issues"><img src="https://img.shields.io/github/issues/Nicolas-Cilia/Backoffice-Printing?style=flat-square&cacheSeconds=3600" alt="Issues"></a>
</p>

<p align="center">
  <a href="#what-this-install-is">Install</a> •
  <a href="#tools">Tools</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#license">License</a>
</p>

---

**This is a personal rework of [Bambuddy](https://github.com/maziggy/bambuddy)** by
[maziggy](https://github.com/maziggy) and contributors. Most of the design and code
here is theirs. This repository is not affiliated with or endorsed by the upstream
project. If you want the maintained, full-featured product, go there:
**[github.com/maziggy/bambuddy](https://github.com/maziggy/bambuddy)**.

---

## What this install is

Backoffice Printing is a self-hosted app for a shop-floor Bambu Lab setup: live
printer control, filament inventory, production files, and local print profiles.

**Native Mac is what currently works.** The backend is a Python virtualenv plus
**uvicorn on port 8000**. In development the frontend is **Vite on port 5173**.

**Docker Compose is a first-class intended install path**, not leftover packaging.
The compose file lives at the repo root (`build: .` plus an `image:` name). This
fork does not publish GHCR or Docker Hub tags, so the documented Docker command is
`docker compose up -d --build` from this source tree. Native is the path that runs
today; Docker is kept and documented because it is meant to run here too.

## Tools

The sidebar in this install is: **Printers**, **Inventory**, **Queue**, **Files**,
**Profiles**, **Maintenance**, **Stats**, **Notifications**, **Settings**.

### Printers

Live printer status, cameras, AMS, and start / stop / pause.

### Inventory

Spools, colors, and AMS assignment.

### Queue

The Queue tab is still in the sidebar. Prints started from Files still go through
the queue machinery.

### Files

File Manager landing page, production sections, and per-printer folders. Production
part slots hold **one live 3MF**. Replacing a file diffs the new 3MF against the
locked print-settings contract. You can print from a file on this tab.

### Profiles

Local presets only. Unfiled processes, part process sections, spec chips on process
cards, and download of stored preset JSON.

### Maintenance

Per-printer maintenance types, intervals, and due tracking.

### Stats

Print activity, filament use, and related totals from local history.

### Notifications

Per-user email preferences for print start, complete, failed, and stopped.

### Settings

Printers, users, appearance, and the rest of the local install configuration.

## Quick Start

### Requirements

- Python 3.11+ and Node.js 20+ (native path)
- Docker with Compose (Docker path)
- A Bambu Lab printer with **Developer Mode** enabled (see below)
- Same local network as the printer

### Native (currently working)

```bash
git clone https://github.com/Nicolas-Cilia/Backoffice-Printing.git
cd Backoffice-Printing
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Backend — http://localhost:8000
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --loop asyncio
```

In a second terminal, for frontend development:

```bash
cd frontend
npm install
npm run dev
```

Vite serves the UI at **http://localhost:5173** and proxies API calls to uvicorn.
If the frontend has already been built (`cd frontend && npm run build`), uvicorn
on port 8000 also serves the UI from `static/`.

### Docker (intended)

From this repository:

```bash
git clone https://github.com/Nicolas-Cilia/Backoffice-Printing.git
cd Backoffice-Printing
docker compose up -d --build
```

Open **http://localhost:8000**. Always pass `--build` so Compose builds from this
tree. The compose file also names `ghcr.io/nicolas-cilia/backoffice-printing:latest`;
that tag is not published by this fork, so a plain `docker compose up -d` (pull
only) is not the install path.

On macOS / Windows Docker Desktop, `network_mode: host` is not supported. Comment
that line out in `docker-compose.yml` and uncomment the `ports:` block. Printer
discovery will not work in that mode — add printers by IP.

### Enabling Developer Mode

Developer Mode lets this app control the printer on the local network.

1. On the printer: **Settings** → **Network** → **LAN Only Mode** → Enable
2. Enable **Developer Mode** (it appears after LAN Only Mode is on)
3. Note the **Access Code**
4. Note the printer IP in network settings
5. Note the serial number in device info

Developer Mode turns off cloud features on the printer and gives full local
control. Standard LAN Mode without Developer Mode is read-only monitoring.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Python, FastAPI, SQLAlchemy |
| Frontend | React, TypeScript, Tailwind CSS |
| Database | SQLite |
| Communication | MQTT (TLS), FTPS |

## Contributing

This is a personal rework. Outside contributions are not expected. If you want the
maintained Bambuddy project, use [maziggy/bambuddy](https://github.com/maziggy/bambuddy).
How this repository is developed is in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

AGPL-3.0 — see [LICENSE](LICENSE).

## Acknowledgments

- **[Bambuddy](https://github.com/maziggy/bambuddy) by [maziggy](https://github.com/maziggy)**
  and contributors — this fork is built on their work. Most of the design and code
  originate there.
- [SpoolEase](https://github.com/yanshay/SpoolEase) by yanshay — early inspiration
  for NFC-based spool tracking and AMS inventory concepts
- [Bambu Lab](https://bambulab.com/) for the printers
- The reverse engineering community for protocol documentation
