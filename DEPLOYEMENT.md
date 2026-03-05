# Attendance App Deployment Guide
## Scratch → Production → Go-Live (Using Cloudflare Tunnel)
```
This guide explains how to deploy the **Attendance App** so it can be accessed securely from **multiple office locations** over the internet.

The system runs on a **Linux server inside a VirtualBox VM** located in **Office A**.

Employees from **Office A, Office B, and Office C** access the system through a secure tunnel.

---

```
# System Architecture
```
Employees (Office A / B / C)
↓
Internet
↓
Cloudflare
↓
Secure Tunnel
↓
Office A Server (Virtual Machine)
↓
Nginx
↓
Gunicorn
↓
Flask Attendance Application

```

Advantages:

- No router port forwarding
- No public IP required
- Secure HTTPS connection
- Works across multiple networks
- Automatic restart on system boot
- Easy to maintain

---

# Phase 1 — Prepare the Server

## Install VirtualBox

Install:

- Oracle VM VirtualBox
- VirtualBox Extension Pack

Download:

https://www.virtualbox.org/wiki/Downloads

Restart the computer after installation.

---

# Phase 2 — Create Linux Server VM

Create a new Virtual Machine.

### VM Configuration

```

Name: attendance-server
Operating System: Ubuntu Server 22.04 LTS
RAM: 2 GB
CPU: 1 core
Disk: 20 GB

```

Network configuration:

```

Adapter 1 → Bridged Adapter

```

This allows the VM to behave like a **normal device on the network**.

---

# Phase 3 — Install Ubuntu Server

Install **Ubuntu Server 22.04 LTS**.

During installation enable:

```

Install OpenSSH Server

```

Create a user:

```

username: sheetam
password: ********

````

After installation reboot the VM.

---

# Phase 4 — Configure Server

Update system packages:

```bash
sudo apt update
sudo apt upgrade -y
````

Install required packages:

```bash
sudo apt install python3 python3-venv python3-pip git nginx -y
```

---

# Phase 5 — Deploy Attendance Application

Clone the repository:

```bash
cd /opt
sudo git clone https://github.com/SheetamCoondoo/Attendance-App.git attendance-app
cd attendance-app
```

Create Python virtual environment:

```bash
python3 -m venv .venv
```

Activate environment:

```bash
source .venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

---

# Phase 6 — Configure Production Environment

Create environment file:

```bash
cp .env.example .env
nano .env
```

Example configuration:

```
APP_ENV=production
SECRET_KEY=LONG_RANDOM_SECRET
TRUST_PROXY=1

REQUIRE_OFFICE_NETWORK=0
ALLOW_ADMIN_FROM_ANYWHERE=1
```

Generate a secure secret key:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(64))"
```

---

# Phase 7 — Test Gunicorn Server

Load environment variables:

```bash
set -a
source .env
set +a
```

Start the application server:

```bash
.venv/bin/gunicorn --workers 1 --threads 4 --bind 127.0.0.1:8000 wsgi:application
```

Test locally:

```
http://SERVER_IP:8000/login
```

Stop server:

```
CTRL + C
```

---

# Phase 8 — Create Auto-Start Service

Create system service:

```bash
sudo nano /etc/systemd/system/attendance.service
```

Service configuration:

```
[Unit]
Description=Attendance App
After=network.target

[Service]
User=sheetam
WorkingDirectory=/opt/attendance-app
EnvironmentFile=/opt/attendance-app/.env
ExecStart=/opt/attendance-app/.venv/bin/gunicorn --workers 1 --threads 4 --bind 127.0.0.1:8000 wsgi:application
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable attendance
sudo systemctl start attendance
```

Check status:

```bash
sudo systemctl status attendance
```

---

# Phase 9 — Configure Nginx

Create Nginx configuration:

```bash
sudo nano /etc/nginx/sites-available/attendance
```

Configuration:

```
server {
    listen 80;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/attendance /etc/nginx/sites-enabled/
```

Test configuration:

```bash
sudo nginx -t
```

Restart Nginx:

```bash
sudo systemctl restart nginx
```

Test locally:

```
http://SERVER_IP/login
```

---

# Phase 10 — Create Cloudflare Account

Create account:

[https://cloudflare.com](https://cloudflare.com)

Add your domain.

Example:

```
attendance.yourcompany.com
```

Change the domain nameservers to Cloudflare.

---

# Phase 11 — Install Cloudflare Tunnel

Install cloudflared:

```bash
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb
```

Login:

```bash
cloudflared tunnel login
```

Authorize the domain in the browser.

---

# Phase 12 — Create Tunnel

Create tunnel:

```bash
cloudflared tunnel create attendance-tunnel
```

Create configuration file:

```bash
sudo nano /etc/cloudflared/config.yml
```

Configuration example:

```
tunnel: attendance-tunnel
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: attendance.yourcompany.com
    service: http://localhost:80
  - service: http_status:404
```

---

# Phase 13 — Connect Domain

Route DNS:

```bash
cloudflared tunnel route dns attendance-tunnel attendance.yourcompany.com
```

---

# Phase 14 — Run Tunnel Service

Install service:

```bash
sudo cloudflared service install
```

Start service:

```bash
sudo systemctl start cloudflared
```

Enable startup:

```bash
sudo systemctl enable cloudflared
```

---

# Phase 15 — Test Public Access

Open the application from anywhere:

```
https://attendance.yourcompany.com/login
```

Accessible from:

* Office A
* Office B
* Office C
* Home networks
* Mobile phones

---

# Phase 16 — Auto Start VM on Windows Boot

Create file:

```
C:\attendance-vm.bat
```

Content:

```
"C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" startvm "attendance-server" --type headless
```

Add file to Windows startup:

```
Win + R → shell:startup
```

Place the `.bat` file inside the startup folder.

---

# Daily Startup Flow

```
Power ON PC
     ↓
Windows boots
     ↓
VirtualBox starts VM
     ↓
Ubuntu boots
     ↓
attendance.service starts
     ↓
Nginx running
     ↓
Cloudflare tunnel connects
```

Employees open:

```
https://attendance.yourcompany.com/login
```

---

# Final Go-Live Checklist

## Verify Server Running

```bash
sudo systemctl status attendance
```

Expected:

```
active (running)
```

---

## Verify Nginx

```bash
sudo systemctl status nginx
```

---

## Internal Test

```
http://192.168.1.50/login
```

---

## External Test

```
https://attendance.yourcompany.com/login
```

---

# Change Default Credentials

Default credentials created during initialization:

```
ADMIN001 / 1234
EMP001 / 1111
```

Change immediately from the **Admin Dashboard**.

---

# Database Backup

Database location:

```
/opt/attendance-app/database.db
```

Create backup script:

```bash
sudo nano /opt/attendance-backup.sh
```

Script:

```bash
#!/bin/bash
cp /opt/attendance-app/database.db /opt/database_backup_$(date +%F).db
```

Make executable:

```bash
sudo chmod +x /opt/attendance-backup.sh
```

Add cron job:

```bash
crontab -e
```

```
0 23 * * * /opt/attendance-backup.sh
```

Backup runs every night at **11 PM**.

---

# Automatic Midnight Attendance Close

API endpoint:

```
POST /admin/run-midnight-close
```

Automate with cron:

```
0 0 * * * curl -X POST http://127.0.0.1/admin/run-midnight-close
```

This marks:

* Absent employees
* Automatic logout

---

# Firewall Protection

Install firewall:

```bash
sudo apt install ufw
```

Allow ports:

```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
```

Enable firewall:

```bash
sudo ufw enable
```

---

# Monitoring Commands

Check logs:

```bash
journalctl -u attendance -f
```

Restart server:

```bash
sudo systemctl restart attendance
```

Restart Nginx:

```bash
sudo systemctl restart nginx
```

---

# Updating the System

Whenever you update the code:

```bash
cd /opt/attendance-app
git pull
source .venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart attendance
```

---

# Production Flow

```
Employee
    ↓
Office A / B / C
    ↓
Internet
    ↓
attendance.yourcompany.com
    ↓
Cloudflare Tunnel
    ↓
Ubuntu VM Server
    ↓
Nginx
    ↓
Gunicorn
    ↓
Flask Attendance App
```

---

# Operational Rule

Each day:

```
Turn ON the server PC
```

Everything else starts automatically:

```
Windows
→ VirtualBox
→ Ubuntu
→ attendance.service
→ Gunicorn
→ Nginx
→ Cloudflare Tunnel
→ Attendance App
```

No manual intervention required.

```
