# BamBuddy Installation Scripts

Interactive installation scripts for BamBuddy, run natively from a git checkout.

## Quick Start

### Native Installation

**Linux/macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/Nicolas-Cilia/Backoffice-Printing/main/install/install.sh -o install.sh && chmod +x install.sh && ./install.sh
```

### Windows Native Installation

**Windows PowerShell:**

```powershell
powershell -ExecutionPolicy Bypass -Command "iwr -useb https://raw.githubusercontent.com/Nicolas-Cilia/Backoffice-Printing/main/install/windows-installer.ps1 -OutFile windows-installer.ps1; .\windows-installer.ps1"
```

**Unattended:**
```powershell
.\windows-installer.ps1 -InstallDir C:\Bambuddy -Port 8000 -Yes
```
---

## Scripts Overview

| Script | Platform | Method |
|--------|----------|--------|
| `install.sh` | Linux, macOS | Native (Python venv) |
| `windows-installer.ps1` | Windows (Native) | Windows Service |
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
### `windows-installer.ps1` (Windows)

Windows PowerShell (run as Administrator — the installer self-elevates via UAC if not):

```powershell
powershell -ExecutionPolicy Bypass -Command "iwr -useb https://raw.githubusercontent.com/Nicolas-Cilia/Backoffice-Printing/main/install/windows-installer.ps1 -OutFile windows-installer.ps1; .\windows-installer.ps1"
```

> Installs Bambuddy natively on Windows using Git, Python, a virtual environment, and optional NSSM Windows Service registration. See the [Windows Installer Guide](https://wiki.bambuddy.cool/getting-started/windows-installer/) for full parameter reference.

**Parameters:**
```powershell
-InstallDir PATH  Installation directory (default: C:\Bambuddy)
-Port PORT        Port to listen on (default: 8000)
-Yes              Non-interactive mode, accept defaults
-Silent           Non-interactive mode with reduced console output
-NoService        Skip Windows Service setup
-NoStart          Do not start Bambuddy at the end
-LocalOnly        Bind to 127.0.0.1 instead of all LAN interfaces
```

The installer stores the Git checkout in `INSTALL_DIR\bambuddy`, user data in
`INSTALL_DIR\data`, and application logs in `INSTALL_DIR\logs` so updates and
re-clones do not delete runtime data. If an earlier Windows installer run left
runtime data in the Git checkout, the installer moves known data and log paths
to the new locations before starting Bambuddy.

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

**Windows (NSSM service):**
```powershell
Get-Service Bambuddy        # Check status
Start-Service Bambuddy      # Start
Stop-Service Bambuddy       # Stop
Restart-Service Bambuddy    # Restart
Get-Content "C:\Bambuddy\bambuddy-runtime.log" -Tail 100 -Wait  # View logs
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

**Windows (native):** rerun the installer; it detects the existing checkout and offers `git pull`, leaving `INSTALL_DIR\data` and `INSTALL_DIR\logs` untouched. Stop the service first if it is registered:
```powershell
Stop-Service Bambuddy
.\windows-installer.ps1 -Yes
Start-Service Bambuddy
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

```powershell
# Windows
Get-NetTCPConnection -LocalPort 8000 -State Listen
```

### Windows: Service Won't Start
Test the start script manually first:
```powershell
powershell.exe -ExecutionPolicy Bypass -File "C:\Bambuddy\Start-Bambuddy.ps1"
```

Then check the NSSM runtime logs:
```powershell
Get-Content "C:\Bambuddy\bambuddy-runtime-error.log" -Tail 100
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
