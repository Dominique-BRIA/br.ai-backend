#!/bin/sh
# Installe la machine cloud du cuisinier de <br/> sur une VM Debian 12 ou Ubuntu 24.04 x64 (Azure B2ats_v2, 1 Go).
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

echo "== Rendu des documents (LibreOffice, sans ce qui n'est pas utile)"
apt-get install -y --no-install-recommends libreoffice-impress poppler-utils fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea

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
/opt/bria-python/bin/pip install --quiet python-pptx python-docx openpyxl reportlab matplotlib pillow trafilatura ddgs

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

# L'outil de documents du cuisinier, disponible dans ses commandes.
cat > /usr/local/bin/bria-doc <<'EOF'
#!/bin/sh
exec /opt/bria-python/bin/python -I -B /opt/bria/packages/worker/outils/bria_doc.py "$@"
EOF
chmod 0755 /usr/local/bin/bria-doc

cat > /usr/local/bin/bria-web <<'EOF'
#!/bin/sh
exec /opt/bria-python/bin/python -I -B /opt/bria/packages/worker/outils/bria_web.py "$@"
EOF
chmod 0755 /usr/local/bin/bria-web

echo "== Moteur de recherche (SearXNG, réservé à cette machine)"
# Il interroge plusieurs moteurs publics ; il n'écoute que sur 127.0.0.1 et n'est jamais exposé.
apt-get install -y python3-dev python3-babel build-essential libxslt-dev zlib1g-dev libffi-dev libssl-dev
id searxng >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --home-dir /usr/local/searxng --create-home searxng
if [ -d /usr/local/searxng/searxng-src/.git ]; then
  sudo -u searxng git -C /usr/local/searxng/searxng-src pull --ff-only
else
  sudo -u searxng git clone --depth 1 https://github.com/searxng/searxng /usr/local/searxng/searxng-src
fi
[ -x /usr/local/searxng/searx-pyenv/bin/python ] || sudo -u searxng python3 -m venv /usr/local/searxng/searx-pyenv
sudo -u searxng /usr/local/searxng/searx-pyenv/bin/pip install --quiet -U pip setuptools wheel pyyaml msgspec typing-extensions pybind11
sudo -u searxng sh -c 'cd /usr/local/searxng/searxng-src && /usr/local/searxng/searx-pyenv/bin/pip install --quiet --use-pep517 --no-build-isolation -e .'
sudo -u searxng /usr/local/searxng/searx-pyenv/bin/pip install --quiet granian
mkdir -p /etc/searxng
if [ ! -f /etc/searxng/settings.yml ]; then
  cat > /etc/searxng/settings.yml <<EOF
use_default_settings: true
general:
  instance_name: "br-ia"
search:
  safe_search: 1
  formats:
    - html
    - json
server:
  secret_key: "$(openssl rand -hex 32)"
  bind_address: "127.0.0.1"
  port: 8888
  limiter: false
  image_proxy: false
EOF
fi
chown -R root:searxng /etc/searxng
chmod 0640 /etc/searxng/settings.yml
cat > /etc/systemd/system/searxng.service <<'EOF'
[Unit]
Description=SearXNG, moteur de recherche des IA de <br/>
After=network-online.target
Wants=network-online.target

[Service]
User=searxng
Group=searxng
Environment=SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml
WorkingDirectory=/usr/local/searxng/searxng-src
ExecStart=/usr/local/searxng/searx-pyenv/bin/granian --interface wsgi --host 127.0.0.1 --port 8888 searx.webapp:app
Restart=always
RestartSec=10
MemoryMax=400M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable searxng
systemctl restart searxng

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
# Ni les services internes de l'hébergeur (métadonnées, jetons), ni le réseau interne, ni l'envoi de mails.
cat > /usr/local/sbin/bria-pare-feu <<'EOF'
#!/bin/sh
# Lancé par le service, dont le PATH ne contient pas /usr/sbin. Une règle refusée arrête tout :
# le travailleur ne doit pas démarrer avec un pare-feu incomplet.
PATH=/usr/sbin:/sbin:/usr/bin:/bin
set -e
RUN_UID=$(id -u bria-run)
iptables -F BRIA_RUN 2>/dev/null || iptables -N BRIA_RUN
iptables -C OUTPUT -m owner --uid-owner "$RUN_UID" -j BRIA_RUN 2>/dev/null \
  || iptables -I OUTPUT -m owner --uid-owner "$RUN_UID" -j BRIA_RUN
# Seule exception : les noms de domaine, par le résolveur local de la VM ou celui de l'hébergeur.
for resolver in 127.0.0.53 168.63.129.16 169.254.169.254; do
  iptables -A BRIA_RUN -p udp -d "$resolver" --dport 53 -j RETURN
  iptables -A BRIA_RUN -p tcp -d "$resolver" --dport 53 -j RETURN
done
# 168.63.129.16 : l'adresse interne de la plateforme Azure.
for network in 168.63.129.16/32 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8; do
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
# Les fichiers écrits par le travailleur restent modifiables par les commandes de l'IA.
UMask=0002
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
