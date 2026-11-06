#!/bin/sh
# Installe la machine cloud du cuisinier de <br/> sur une VM Debian 12 (Google Cloud e2-micro).
# À lancer en root :  sudo sh installer.sh
#
# Deux comptes Linux :
#  - bria : le travailleur. Il garde le jeton de la machine, les jetons GitHub et les dossiers .git.
#  - bria-run : les commandes lancées par l'IA. Il n'a accès à rien de tout cela.
set -eu

SERVER_URL="${BRIA_SERVER_URL:-https://br-ia-api-a8gwhdfxccd6cham.germanywestcentral-01.azurewebsites.net}"
REPO="${BRIA_REPO:-https://github.com/Dominique-BRIA/br.ai-backend.git}"
NODE_VERSION="24.14.0"

echo "== Paquets"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates xz-utils sudo iptables python3 python3-venv procps pandoc fonts-dejavu-core

echo "== Node.js $NODE_VERSION"
if ! node --version 2>/dev/null | grep -q "^v$NODE_VERSION$"; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1
fi

echo "== Mémoire d'échange (1 Go de RAM ne suffit pas à npm install)"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Python et bibliothèques de documents"
if [ ! -x /opt/bria-python/bin/python ]; then
  python3 -m venv /opt/bria-python
fi
/opt/bria-python/bin/pip install --quiet --upgrade pip
/opt/bria-python/bin/pip install --quiet python-pptx python-docx openpyxl reportlab matplotlib pillow

echo "== Comptes et dossiers"
id bria-run >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin bria-run
id bria >/dev/null 2>&1 || useradd --system --home-dir /srv/bria --shell /usr/sbin/nologin --groups bria-run bria
mkdir -p /srv/bria/travail /srv/bria/etat /srv/bria/espaces /etc/bria
chown bria:bria-run /srv/bria /srv/bria/travail
chmod 0750 /srv/bria
chmod 2770 /srv/bria/travail
chown bria:bria /srv/bria/etat
chmod 0700 /srv/bria/etat
# Le coffre des espaces des projets : fermé à bria-run, qui ne voit que le projet en cours.
chown bria:bria /srv/bria/espaces
chmod 0700 /srv/bria/espaces

# Le travailleur lance les commandes de l'IA sous bria-run, et rien d'autre.
cat > /etc/sudoers.d/bria <<'EOF'
Defaults:bria !requiretty, !lecture
bria ALL=(bria-run) NOPASSWD: ALL
EOF
chmod 0440 /etc/sudoers.d/bria

echo "== Programme"
if [ -d /opt/bria/.git ]; then
  git -C /opt/bria pull --ff-only
else
  git clone --depth 1 "$REPO" /opt/bria
fi
cd /opt/bria
npm ci --omit=dev --workspace=@br-ia/worker --no-audit --no-fund
chown -R root:root /opt/bria
chmod -R go-w /opt/bria

echo "== Jeton de la machine"
if [ ! -f /etc/bria/worker.env ]; then
  printf "Collez le jeton donné par l'administration (Machines cloud), puis Entrée : "
  stty -echo 2>/dev/null || true
  read -r TOKEN
  stty echo 2>/dev/null || true
  echo
  umask 077
  cat > /etc/bria/worker.env <<EOF
BRIA_SERVER_URL=$SERVER_URL
BRIA_MACHINE_TOKEN=$TOKEN
BRIA_WORK_ROOT=/srv/bria/travail
BRIA_STATE_DIR=/srv/bria/etat
BRIA_SPACES_ROOT=/srv/bria/espaces
BRIA_RUN_AS=bria-run
EOF
  umask 022
fi
chown root:root /etc/bria/worker.env
chmod 0600 /etc/bria/worker.env

echo "== Pare-feu des commandes de l'IA"
# Ni le serveur de métadonnées de Google (il donne des jetons), ni le réseau interne, ni l'envoi de mails.
cat > /usr/local/sbin/bria-pare-feu <<'EOF'
#!/bin/sh
RUN_UID=$(id -u bria-run)
iptables -F BRIA_RUN 2>/dev/null || iptables -N BRIA_RUN
iptables -C OUTPUT -m owner --uid-owner "$RUN_UID" -j BRIA_RUN 2>/dev/null \
  || iptables -I OUTPUT -m owner --uid-owner "$RUN_UID" -j BRIA_RUN
for network in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8; do
  iptables -A BRIA_RUN -d "$network" -j REJECT
done
iptables -A BRIA_RUN -p tcp --dport 25 -j REJECT
EOF
chmod 0755 /usr/local/sbin/bria-pare-feu

echo "== Service"
cat > /etc/systemd/system/bria-worker.service <<'EOF'
[Unit]
Description=Machine cloud du cuisinier de <br/>
After=network-online.target
Wants=network-online.target

[Service]
User=bria
Group=bria-run
EnvironmentFile=/etc/bria/worker.env
Environment=PATH=/opt/bria-python/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/opt/bria/packages/worker
# Lancé en root. Le travailleur range lui-même ce qu'une coupure aurait laissé.
ExecStartPre=+/usr/local/sbin/bria-pare-feu
ExecStart=/usr/local/bin/node src/main.ts
Restart=always
RestartSec=15
# Une commande ne doit pas pouvoir faire tomber la machine.
MemoryMax=1500M
TasksMax=512
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable bria-worker
systemctl restart bria-worker

sleep 3
systemctl --no-pager --lines=5 status bria-worker || true
echo
echo "Terminé. La machine doit apparaître « en ligne » dans l'administration (Machines cloud)."
echo "Journal : journalctl -u bria-worker -f"
