#!/usr/bin/env bash
set -euo pipefail

EC2_HOST="ec2-52-62-6-243.ap-southeast-2.compute.amazonaws.com"
EC2_USER="ec2-user"
KEY="$HOME/.ssh/benchmark-ec2.pem"
REMOTE="/home/$EC2_USER/mybench"

# ── Require AUTH_SECRET ──────────────────────────────────────────────────────
if [ -z "${AUTH_SECRET:-}" ]; then
  echo "Error: AUTH_SECRET not set."
  echo "Run: export AUTH_SECRET=\$(openssl rand -hex 32)"
  exit 1
fi

echo "→ Building..."
npm run build

echo "→ Uploading..."
ssh -i "$KEY" -o StrictHostKeyChecking=no "$EC2_USER@$EC2_HOST" "mkdir -p $REMOTE/build $REMOTE/data"
rsync -az --delete -e "ssh -i $KEY -o StrictHostKeyChecking=no" build/ "$EC2_USER@$EC2_HOST:$REMOTE/build/"
rsync -az -e "ssh -i $KEY -o StrictHostKeyChecking=no" package.json package-lock.json "$EC2_USER@$EC2_HOST:$REMOTE/"

echo "→ Installing production deps..."
ssh -i "$KEY" -o StrictHostKeyChecking=no "$EC2_USER@$EC2_HOST" "cd $REMOTE && npm ci --omit=dev"

echo "→ Configuring service..."
ssh -i "$KEY" -o StrictHostKeyChecking=no "$EC2_USER@$EC2_HOST" "
  cat > $REMOTE/.env << 'EOF'
AUTH_SECRET=$AUTH_SECRET
DATA_DIR=$REMOTE/data
PORT=3000
NODE_ENV=production
EOF
  chmod 600 $REMOTE/.env

  sudo tee /etc/systemd/system/mybench.service > /dev/null << 'EOF'
[Unit]
Description=mybench
After=network.target

[Service]
Type=simple
User=$EC2_USER
WorkingDirectory=$REMOTE
EnvironmentFile=$REMOTE/.env
ExecStart=/usr/bin/node $REMOTE/build
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable mybench
  sudo systemctl restart mybench
  sleep 2
  sudo systemctl status mybench --no-pager
"

echo ""
echo "✓ Deployed: http://$EC2_HOST:3000"
echo "  logs:    ssh -i $KEY $EC2_USER@$EC2_HOST 'sudo journalctl -u mybench -f'"
echo "  restart: ssh -i $KEY $EC2_USER@$EC2_HOST 'sudo systemctl restart mybench'"
