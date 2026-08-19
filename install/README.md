# BamBuddy Installation Scripts

Interactive installation scripts for BamBuddy, run natively from a git checkout.

## Quick Start

### Native Installation

**Linux/macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/Nicolas-Cilia/Backoffice-Printing/main/install/install.sh -o install.sh && chmod +x install.sh && ./install.sh
```

---

## Scripts Overview

| Script | Platform | Method |
|--------|----------|--------|
| `install.sh` | Linux, macOS | Native (Python venv) |
| `update.sh` | Linux (systemd) | Native update helper |

---

## Native Installation Scripts

### `install.sh` (Linux/macOS)

Installs BamBuddy with Python virtual environment and optional systemd/launchd service.

**Supported Systems:**
- Debian/Ubuntu (apt)
- RHEL/Fedora/CentOS (dnf/yum)
- Arch Linux (pacman)
- openSUSE (zypper)
- macOS (Homebrew)

**Options:**
```
--path PATH        Installation directory (default: /opt/bambuddy)
--port PORT        Port to listen on (default: 8000)
--tz TIMEZONE      Timezone (default: system timezone)
--data-dir PATH    Data directory (default: INSTALL_PATH/data)
--log-dir PATH     Log directory (default: INSTALL_PATH/logs)
--debug            Enable debug mode
--log-level LEVEL  Log level: DEBUG, INFO, WARNING, ERROR (default: INFO)
--no-service       Skip systemd/launchd service setup
--yes, -y          Non-interactive mode, accept defaults
```

**Examples:**
```bash
# Interactive installation
./install.sh

# Unattended with custom settings
./install.sh --path /srv/bambuddy --port 3000 --tz America/New_York --yes

# Minimal unattended
./install.sh -y

# Skip service setup
./install.sh --no-service -y
```

---

## Configuration Options

All scripts support these configuration options:

| Option | Description | Default |
|--------|-------------|---------|
| Install Path | Where BamBuddy is installed | `/opt/bambuddy` (Linux) |
| Port | HTTP port for web interface | `8000` |
| Timezone | Server timezone | System timezone or `UTC` |
| Data Directory | Database and archives | `INSTALL_PATH/data` |
| Log Directory | Application logs | `INSTALL_PATH/logs` |
| Debug Mode | Enable verbose logging | `false` |
| Log Level | INFO, WARNING, ERROR, DEBUG | `INFO` |

---

## Post-Installation

### Accessing BamBuddy

After installation, open your browser to:
```
http://localhost:8000
```

Or use the port you specified during installation.

### Service Management

**Linux (systemd):**
```bash
sudo systemctl status bambuddy    # Check status
sudo systemctl start bambuddy     # Start
sudo systemctl stop bambuddy      # Stop
sudo systemctl restart bambuddy   # Restart
sudo journalctl -u bambuddy -f    # View logs
```

**macOS (launchd):**
```bash
launchctl list | grep bambuddy                              # Check status
launchctl load ~/Library/LaunchAgents/com.bambuddy.app.plist    # Start
launchctl unload ~/Library/LaunchAgents/com.bambuddy.app.plist  # Stop
```

### Updating

**Native installation:**
```bash
curl -fsSL https://raw.githubusercontent.com/Nicolas-Cilia/Backoffice-Printing/main/install/update.sh -o update.sh
chmod +x update.sh
sudo ./update.sh
```

The updater performs:
- Root permission check (fails fast before any work)
- Optional built-in backup API call (`/api/v1/settings/backup`) before update
- Keeps only the newest 5 local backup ZIP files
- Local-change warning + confirmation before `git reset --hard`
- If remote has no new commits, updater exits early without stopping the service
- Service stop/start with code rollback + service restart attempt if update fails

Useful environment overrides:
```bash
# Typical native install defaults
INSTALL_DIR=/opt/bambuddy SERVICE_NAME=bambuddy sudo ./update.sh

# Require backup to succeed (abort update if backup fails)
BACKUP_MODE=require sudo ./update.sh

# Skip backup API call
BACKUP_MODE=skip sudo ./update.sh

# Auth-enabled instances: provide API key for backup endpoint
BAMBUDDY_API_KEY=bb_xxx BACKUP_MODE=require sudo ./update.sh
```

---

## Troubleshooting

### Permission Denied (Linux)
Run with `sudo` or ensure your user has appropriate permissions:
```bash
sudo ./install.sh
```

### Service Won't Start
Check logs for errors:
```bash
# Linux
sudo journalctl -u bambuddy -n 50
```

### Port Already in Use
Choose a different port during installation or stop the conflicting service:
```bash
# Find what's using port 8000
sudo lsof -i :8000  # Linux/macOS
```

---

## Requirements

### Native Installation
- Python 3.10+ (automatically installed if missing)
- Node.js 18+ (automatically installed if missing)
- Git (automatically installed if missing)
- ~500MB disk space

---

## Support

- **Documentation:** https://wiki.bambuddy.cool
- **Issues:** https://github.com/Nicolas-Cilia/Backoffice-Printing/issues
