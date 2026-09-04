# Backoffice Printing — core rules for Claude

Wes's fork of Nico's Bambuddy rework. It runs a live 13-printer Bambu Lab floor
from the warehouse Mac mini (Docker, :8484). Mistakes here reach the shop floor.
Read this file first; details live in the linked docs, don't duplicate them here.

## Where the rules live

- `FORK_PLAN.md` — the working agreement. **Do not implement anything not listed
  there.** New work gets an entry (status marker + Status line) before code; shipped
  work moves to the Done table with branch and commit.
- `FORK_CHANGELOG.md` — one dated entry per shipped change (what, why, root cause).
- `CONTRIBUTING.md` — setup, code style, i18n, tests, auth pattern, git workflow.
- `SECURITY.md` — CI rules for auth changes.

## Git and PRs

- Branch from `dev`. **PRs target `dev`, never `main`.** Promoting `dev` to `main`
  is a separate step Wes does.
- Never push to `main`. Never force-push a branch someone else has checked out.
- `origin` is Nico's repo, `Nicolas-Cilia/Backoffice-Printing` (Wes has push; Gaspi is a
  collaborator; the Mac pulls its GHCR image). Wes's fork `wes-commits01/Backoffice-Printing`
  is the `fork` remote, kept only as a scratch mirror.
- **Gaspi (`gasparhabif`) reviews PRs to `main` only** (the `dev` -> `main` promotion).
  PRs to `dev` need no reviewer. The hook requests him automatically when the base is
  `main`; by hand: `gh pr edit <n> --add-reviewer gasparhabif`. Gaspi owns the Mac deploy
  and is AI-nervous, so CI must be fully green before that promotion PR goes up.
- The `GH_TOKEN` in `~/.claude/CLAUDE.md` may be dead. If git or `gh` returns 401,
  use the keyring: `env -u GH_TOKEN gh ...` and
  `env -u GH_TOKEN git -c credential.helper= -c 'credential.helper=!gh auth git-credential' <push|pull>`.
- Commit as Wes. Small commits, one unit per branch.

## SOP: shipping a change (Nico's flow, confirmed by Wes 2026-09-04)

1. Confirm the change is listed in `FORK_PLAN.md` (add an entry if Wes asked for it).
2. `git fetch origin && git checkout -b <type>/<slug> origin/dev`. Never work on `dev` or `main`.
3. Make the change. Add or update tests. Add the `FORK_CHANGELOG.md` entry.
4. Local gates: `npx tsc --noEmit`, eslint, vitest for the touched area, `npm run build`,
   ruff for backend changes. Then `git checkout -- static`.
5. Manual test on the local stack with real data: Wes exports a backup ZIP from the
   floor app, Claude extracts `bambuddy.db` into `data/` (see Local run), restarts the
   backend, reproduces the bug before the fix and confirms it after, in the browser pane.
6. Commit as Wes, push the branch, `gh pr create --base dev`. The hooks enforce the
   base. Tick the test plan in the PR body honestly. No reviewer needed on `dev`.
7. Wait for CI. Wes merges into `dev`. When `dev` is stable, the promotion PR
   `gh pr create --base main --head dev` goes up; the hook requests `gasparhabif`, and
   only after his review does it merge.
8. Image publish is still manual (`docker-publish.sh`, Nico's way; a workflow is pending).
   Wes or Gaspi then runs `docker compose pull && docker compose up -d` on the Mac. Claude never does.

## Quality bar ("done" means)

- `./test_all.sh` green plus `cd frontend && npm run build`.
- Before pushing: `ruff check backend/ && ruff format --check backend/`,
  `cd frontend && npm run lint && npx tsc --noEmit && npm run test:run`.
- User-facing strings go through `t()`; add the key to **every** locale in
  `frontend/src/i18n/locales/` with a real translation. `npm run check:i18n` must pass.
- New or changed behavior gets a test (`backend/tests/`, `frontend/src/__tests__/`).
- Upstream mergeability is not a goal. Edit upstream files directly; delete
  upstream tests a change invalidates.

## Repo gotchas

- `static/` (the built UI) **is tracked**. Never commit a local build:
  `git checkout -- static` before branching or committing.
- `bambuddy.db*`, `data/`, `.env`, `*.log` are gitignored local state. The local
  DB is test data, never the Mac's.
- Schema changes: migrations run automatically on startup, so a bad tag can
  mutate prod data. Note any migration in `FORK_CHANGELOG.md` and suffix the tag
  `-mig`; rollback then means restoring the volume snapshot, not just the old image.

## Local run

- `.claude/launch.json` has `backend` (uvicorn `--reload` on :7474) and `frontend`
  (attach to Vite on :5173). Vite proxies API calls to :7474; develop against :5173.
- Windows gotcha: killing the uvicorn parent leaves the reload child holding :7474.
  Find it with `Get-NetTCPConnection -LocalPort 7474` and stop that PID.
- Virtual printer mode (`virtual_printer/`) exercises flows without touching the fleet.

## Deploy (the Mac)

- Mac pulls `ghcr.io/nicolas-cilia/backoffice-printing:latest` (see `docker-compose.yml`)
  and runs `docker compose pull && docker compose up -d`. Nothing AI-shaped runs on the Mac.
- Never rebuild :8484 during a shift. Stage on :8485 with a cloned volume, verify,
  then swap. Snapshot `bambuddy_data` before every deploy.
- **Never touch the Mac.** No HTTP (not even a GET), no SSH, no backup trigger, no deploy,
  no read against its address or :8484, from any session. Wes or Gaspi does everything
  on the Mac by hand; Claude prepares tags, instructions, and files. Need its data? Ask
  Wes to export Settings > Backup and hand over the ZIP. Enforced by guard_bash.py via
  the gitignored `.claude/hooks/protected-hosts.txt` (copy the `.example`, add the Mac's
  LAN address; the public repo never carries it).

## Communication

- Terse. Wes-facing output is at most five sentences. Work goes into repo files,
  not chat.
- Do not fabricate data. Leave `[NEEDS MANUAL INPUT]` where you don't know.
