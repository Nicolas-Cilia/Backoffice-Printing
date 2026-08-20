# Contributing

This repository is a **personal rework** of
[Bambuddy](https://github.com/maziggy/bambuddy). Outside contributions are not
expected. If you want the maintained, full-featured project and its community
process, go there instead: **https://github.com/maziggy/bambuddy**.

The rest of this file is how *this* checkout is developed.

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Development setup

### Prerequisites

- Python 3.11+
- Node.js 20+
- npm
- Docker with Compose (optional; alternate run path)

### Clone

```bash
git clone https://github.com/Nicolas-Cilia/Backoffice-Printing.git
cd Backoffice-Printing
```

### Backend

```bash
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

pip install -r requirements.txt
pip install -r requirements-dev.txt  # pytest, ruff, bandit, etc.

pip install pre-commit
pre-commit install

DEBUG=true uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 7474 --loop asyncio
```

The API is at **http://localhost:7474**.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Vite serves the UI at **http://localhost:5173** and proxies API requests to the
backend on port 7474.

### Docker (alternate run path)

Docker Compose is an intended way to *run* the app, built from this tree. This
fork does not publish images.

```bash
docker compose up -d --build
```

Always pass `--build`. The compose file names a GHCR tag this fork does not
publish.

To run the test compose services (mirrors CI):

```bash
docker compose -f docker-compose.test.yml run --rm backend-test
docker compose -f docker-compose.test.yml run --rm frontend-test
```

## Code style

### Backend (Python)

[Ruff](https://github.com/astral-sh/ruff) for lint and format. Config is in
`pyproject.toml`.

```bash
ruff check backend/
ruff check --fix backend/
ruff format backend/
ruff format --check backend/
```

### Frontend (TypeScript / React)

```bash
cd frontend
npm run lint
npx tsc --noEmit
```

### Pre-commit

Hooks run Ruff, trailing-whitespace fixes, YAML/JSON validation, and import
shadowing checks:

```bash
pre-commit run --all-files
```

## Internationalization (i18n)

User-facing frontend strings go through [react-i18next](https://react.i18next.com/).
Do not hardcode visible copy.

Translations live in `frontend/src/i18n/locales/`. `en.ts` is the reference;
every other locale file is checked against it.

```bash
cd frontend
npm run check:i18n
```

When adding a string:

1. Add the key to **every** locale file, with a real translation (not an English
   placeholder — the check flags leaves that match `en`).
2. Use `useTranslation()` and `t('section.key')`.
3. Keep the same key structure in every locale.

`npm run test:run` chains the parity check. Plain `npm test` is Vitest watch
mode and skips it. CI runs parity too.

## Testing

From the repo root:

```bash
./test_frontend.sh    # TypeScript check + ESLint + Vitest
./test_backend.sh     # Ruff lint/format + pytest (parallel)
./test_docker.sh      # Docker build plus unit and integration tests
./test_all.sh         # frontend → backend → docker
./test_security.sh    # bandit, pip-audit, npm-audit
```

`test_docker.sh` accepts `--backend-only`, `--skip-integration`, `--fresh` —
run with `--help`. `test_security.sh` is the fast scans by default; `--full`
adds the heavier suite.

**Backend** tests are in `backend/tests/`:

```bash
pytest backend/tests/ -v
pytest backend/tests/unit/
pytest backend/tests/ --cov=backend
```

**Frontend** tests are Vitest, under `frontend/src/__tests__/`:

```bash
cd frontend
npm run test:run       # single run + i18n parity
npm test               # watch mode
npm run test:coverage
```

## Authentication and permissions

Authentication is optional. When it is off, endpoints are open. When it is on,
routes use `RequirePermissionIfAuthEnabled`: no auth setting means a no-op;
otherwise JWT / API key is checked against a permission.

```python
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.permissions import Permission

@router.get("/my-resource")
async def get_my_resource(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.RESOURCE_READ),
):
    ...
```

Permissions are `resource:action` (for example `printers:control`,
`queue:create`, `library:upload`). Add new ones to the `Permission` enum, the
category map, and the default groups in `backend/app/core/permissions.py`.

| Group | Access |
|-------|--------|
| Administrators | All permissions |
| Operators | Printer control, own queue items, read-only settings |
| Viewers | Read-only |

Auth changes must follow the CI rules in [SECURITY.md](SECURITY.md).

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs Ruff, pytest, ESLint,
TypeScript, Vitest, a production frontend build, Docker tests, and security
scans. Run `./test_all.sh` locally before pushing.
