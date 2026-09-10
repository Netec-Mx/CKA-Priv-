#!/usr/bin/env bash
set -euo pipefail
[[ "$(hostname)" == "cka-worker2" ]] || { echo 'ERROR: ejecuta este archivo en cka-worker2.'; exit 1; }
sudo systemctl stop kubelet
echo 'Escenario preparado.'
