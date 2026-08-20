<p align="center">
  <img src="static/img/backoffice_printing_logo.png" alt="Backoffice Printing Logo" width="300">
</p>

<h1 align="center">Backoffice Printing</h1>

<p align="center">
  <strong>Self-hosted shop-floor control for a local Bambu Lab print Farm.</strong>
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
**uvicorn on port 7474**. In development the frontend is **Vite on port 5173**.

**Docker Compose is a first-class install path.** Images are on GHCR as
`ghcr.io/nicolas-cilia/backoffice-printing`. Other machines `docker compose pull`
then `up -d`. This Mac can `--build` from git while developing. Native
(venv + uvicorn :7474, Vite :5173) still works. Details:
[docs/docker-workflow.md](docs/docker-workflow.md).

## Tools

The sidebar in this install is: **Printers**, **Inventory**, **Queue**, **Files**,
**Profiles**, **Maintenance**, **Stats**, **Notifications**, **Settings**.

### Printers

This is the live floor. Each printer is a card with connection state, current job, temperatures, and AMS trays. You can start, pause, resume, and stop a print from the card, open the camera, or jump to a camera wall of every connected printer. Add printers by LAN discovery or by IP, serial, and access code. From an AMS tray you can assign or unassign a spool from Inventory so the slot matches what is actually loaded.


### Filament

This has two tabs: Spools and Tracking. Spools is the local catalog — add and edit spools (material, color, remaining weight, location), import or export CSV, and print labels. The table shows which AMS tray a spool is assigned to; assign and unassign live on the printer card. Tracking is stock and usage by color and material over time, including consumption against the printers.

### Queue

This is the job list behind prints you start from Files. Pending jobs wait here; you can reorder them, start a staged job, cancel, or skip. History and a timeline show what already ran. If plate-clear or resume-after-failure is on in Settings, those gates show up here too.

### Files

This is the File Manager: a folder grid of ungrouped folders plus named sections. A Production section holds one folder per printer model. Inside a printer folder, each part has slots, and each slot holds one live 3MF. Replacing that file previews a spec diff against the locked print-settings contract (match, intended overrides, or mismatch). You can print a sliced 3MF from this tab; the job goes through Queue. Ordinary folders are for upload, tags, rename, and trash.

### Profiles

This is local slicer presets only: filament, printer, and process JSON on this install. Process presets that are not attached to a part sit in Unfiled. Part process sections group processes by part, with a slot per printer model. Process cards show spec chips; you can open the full spec and download the stored preset JSON. Attaching or replacing a process in a part section diffs it against that section’s locked contract, same idea as Files.

### Maintenance

This is per-printer types (lubrication, belts, PTFE, and so on) with intervals in print hours or calendar days. Mark a task done when you do it; the page shows what is due or overdue. You can add custom types and optional documentation links.

### Stats

This is totals from local print history: print count, time, filament, and cost, plus success rate, a calendar, filament trends, and a per-printer breakdown. Filter by timeframe. This is the dashboard on this install, not a separate history product.

### Settings

This is the rest of the local install: language, theme, default landing view, and camera options. Users and permission groups live here when authentication is on, along with SMTP / notification routing and queue dispatch options such as plate-clear. Printers themselves are added on the Printers tab; Settings is where you tune how this host behaves.

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

# Backend — http://localhost:7474
uvicorn backend.app.main:app --host 0.0.0.0 --port 7474 --loop asyncio
```

In a second terminal, for frontend development:

```bash
cd frontend
npm install
npm run dev
```

Vite serves the UI at **http://localhost:5173** and proxies API calls to uvicorn.
If the frontend has already been built (`cd frontend && npm run build`), uvicorn
on port 7474 also serves the UI from `static/`.

### Docker (intended)

**Run the published image** (another PC, or this Mac on a release):

```bash
git clone https://github.com/Nicolas-Cilia/Backoffice-Printing.git
cd Backoffice-Printing
docker compose pull
docker compose up -d
```

**Build from this git tree** (this Mac while developing):

```bash
docker compose up -d --build
```

Open **http://localhost:8484**. Compose publishes host port **8484** (container still uses 8000). To use a different host port, set `HOST_PORT` in `.env` and run `docker compose up -d` — no image rebuild.
Printer discovery will not work in that mode — add printers by IP.

Install, publish, and version bumps: [docs/docker-workflow.md](docs/docker-workflow.md).

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
