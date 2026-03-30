#!/bin/bash

#############################################################################
# Deploy mybench CLI to EC2
#
# Usage: ./deploy-to-ec2.sh [options]
#
# Options:
#   -k, --key PATH           SSH key file (default: ~/.ssh/benchmark-ec2.pem)
#   -h, --host HOST          EC2 host (default: ec2-user@ec2-52-62-6-243.ap-southeast-2.compute.amazonaws.com)
#   -d, --dest FOLDER        Destination folder on EC2 (default: ~/mybench-bench)
#   --no-extract             Don't extract tarball on EC2 (just upload)
#   --help                   Show this help message
#
#############################################################################

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Defaults
SSH_KEY="$HOME/.ssh/benchmark-ec2.pem"
EC2_HOST="ec2-user@ec2-52-62-6-243.ap-southeast-2.compute.amazonaws.com"
EC2_DEST="~/mybench-bench"
EXTRACT=true
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
CLI_DIR="$REPO_ROOT/cli"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -k|--key)
            SSH_KEY="$2"
            shift 2
            ;;
        -h|--host)
            EC2_HOST="$2"
            shift 2
            ;;
        -d|--dest)
            EC2_DEST="$2"
            shift 2
            ;;
        --no-extract)
            EXTRACT=false
            shift
            ;;
        --help)
            grep "^#" "$0" | grep -E "^\s*#" | sed 's/^#\s*//'
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Verify SSH key exists
if [[ ! -f "$SSH_KEY" ]]; then
    echo -e "${RED}Error: SSH key not found at $SSH_KEY${NC}"
    exit 1
fi

# Verify CLI directory exists
if [[ ! -d "$CLI_DIR" ]]; then
    echo -e "${RED}Error: CLI directory not found at $CLI_DIR${NC}"
    exit 1
fi

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}mybench CLI Deployment to EC2${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo "  SSH Key:      $SSH_KEY"
echo "  EC2 Host:     $EC2_HOST"
echo "  Dest Folder:  $EC2_DEST"
echo "  Extract:      $EXTRACT"
echo ""

# Step 1: Detect EC2 architecture
echo -e "${BLUE}[1/5] Detecting EC2 architecture...${NC}"
EC2_ARCH=$(ssh \
    -i "$SSH_KEY" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    "$EC2_HOST" \
    "uname -m" 2>/dev/null || echo "x86_64")

case "$EC2_ARCH" in
    x86_64)
        GO_ARCH="amd64"
        echo -e "${GREEN}✓ Detected: x86_64 (amd64)${NC}"
        ;;
    aarch64)
        GO_ARCH="arm64"
        echo -e "${GREEN}✓ Detected: aarch64 (arm64)${NC}"
        ;;
    *)
        echo -e "${YELLOW}⚠ Unknown architecture: $EC2_ARCH, defaulting to amd64${NC}"
        GO_ARCH="amd64"
        ;;
esac

# Step 2: Build CLI for Linux
echo -e "${BLUE}[2/5] Building CLI for Linux ($GO_ARCH)...${NC}"
cd "$CLI_DIR"

# Cross-compile from macOS to Linux
GOOS=linux GOARCH="$GO_ARCH" go build -o ../bin/mybench-runner-linux ./cmd/...

if [[ -f "$REPO_ROOT/bin/mybench-runner-linux" ]]; then
    echo -e "${GREEN}✓ Binary built: bin/mybench-runner-linux${NC}"
else
    echo -e "${RED}✗ Failed to build binary${NC}"
    exit 1
fi

# Step 3: Create tarball
echo -e "${BLUE}[3/5] Creating tarball...${NC}"
TARBALL="mybench-runner.tar.gz"
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

cp "$REPO_ROOT/bin/mybench-runner-linux" "$TEMP_DIR/mybench-runner"
chmod +x "$TEMP_DIR/mybench-runner"

cd "$TEMP_DIR"
tar -czf "$TARBALL" mybench-runner
TARBALL_SIZE=$(du -h "$TARBALL" | cut -f1)
echo -e "${GREEN}✓ Tarball created: $TARBALL ($TARBALL_SIZE)${NC}"

# Step 4: Upload to EC2
echo -e "${BLUE}[4/5] Uploading to EC2...${NC}"
SCP_DEST="${EC2_HOST}:${EC2_DEST}/"

scp \
    -i "$SSH_KEY" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    "$TARBALL" \
    "$SCP_DEST" || {
    echo -e "${RED}✗ SCP upload failed${NC}"
    exit 1
}
echo -e "${GREEN}✓ Uploaded to EC2: $SCP_DEST${NC}"

# Step 5: Extract on EC2 (optional)
if [[ "$EXTRACT" == true ]]; then
    echo -e "${BLUE}[5/5] Extracting on EC2...${NC}"
    ssh \
        -i "$SSH_KEY" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        "$EC2_HOST" \
        "mkdir -p $EC2_DEST && cd $EC2_DEST && tar -xzf $TARBALL && rm $TARBALL && echo 'Extraction complete'" || {
        echo -e "${RED}✗ Extraction on EC2 failed${NC}"
        exit 1
    }
    echo -e "${GREEN}✓ Extracted on EC2${NC}"
else
    echo -e "${YELLOW}[5/5] Skipping extraction (--no-extract flag set)${NC}"
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Deployment complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "  SSH into EC2: ssh -i $SSH_KEY $EC2_HOST"
echo "  Binary location: $EC2_DEST/mybench-runner"
echo "  Run: $EC2_DEST/mybench-runner run <plan.json>"
echo ""
