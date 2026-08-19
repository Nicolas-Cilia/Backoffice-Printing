# Updating Bambuddy

> **0.2.3 note:** the in-app **Update** button is unreliable when upgrading from
> older releases. Use the commands below instead — they cover every supported
> install path and are safe to run repeatedly.

Pick the section that matches how Bambuddy was installed.

---

## Native install (`install.sh` or manual `git clone`)

Both paths produce a git working tree at the install directory, so the update
is the same. Preferred:

```bash
sudo /opt/bambuddy/install/update.sh
```

`update.sh` stops the service, snapshots the database via the built-in backup
API, fast-forwards to `origin/main`, installs Python deps, rebuilds the
frontend, and restarts the service. It rolls back automatically if any step
fails.

### Manual equivalent

If you'd rather run the steps yourself:

```bash
cd /opt/bambuddy
sudo systemctl stop bambuddy
sudo -u bambuddy git fetch origin
sudo -u bambuddy git reset --hard origin/main
sudo -u bambuddy venv/bin/pip install -r requirements.txt
sudo systemctl start bambuddy
```

Replace `/opt/bambuddy` with your install path if different. Database schema
migrations run automatically on startup — no Alembic step is required.

---

## Installed from a GitHub ZIP or tarball download

These installs have no `.git` directory, so neither `update.sh` nor a plain
`git pull` will work. Reinstall cleanly:

```bash
# 1. Back up your stateful data
sudo systemctl stop bambuddy
sudo tar czf ~/bambuddy-backup.tgz -C /opt/bambuddy \
  data bambuddy.db bambuddy.db-shm bambuddy.db-wal \
  virtual_printer archive projects icons .env 2>/dev/null || true

# 2. Remove the old install and reinstall via install.sh
sudo rm -rf /opt/bambuddy
curl -fsSL https://raw.githubusercontent.com/Nicolas-Cilia/Backoffice-Printing/main/install/install.sh \
  -o /tmp/install.sh && sudo bash /tmp/install.sh --path /opt/bambuddy

# 3. Restore your data
sudo systemctl stop bambuddy
sudo tar xzf ~/bambuddy-backup.tgz -C /opt/bambuddy
sudo systemctl start bambuddy
```

---

## Before you upgrade

Take a backup. Settings → Backup → **Create Backup** downloads a ZIP containing
the database and all stateful directories. Any bare-metal update via
`update.sh` does this automatically; manual upgrades do not.
