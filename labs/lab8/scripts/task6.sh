#!/usr/bin/env bash
set -euo pipefail
MANIFEST=/etc/kubernetes/manifests/kube-scheduler.yaml
[[ "$(hostname)" == "cka-control" ]] || { echo 'ERROR: ejecuta este archivo en cka-control.'; exit 1; }
[[ -f "$MANIFEST" ]] || { echo "ERROR: no existe $MANIFEST"; exit 1; }
sudo cp "$MANIFEST" /var/tmp/.lab8-kube-scheduler.yaml
sudo sed 's#--kubeconfig=/etc/kubernetes/scheduler.conf#--kubeconfig=/etc/kubernetes/scheduler-lab8.conf#' "$MANIFEST" > /tmp/kube-scheduler.yaml
sudo install -o root -g root -m 600 /tmp/kube-scheduler.yaml "$MANIFEST"
rm -f /tmp/kube-scheduler.yaml
echo 'Escenario preparado.'
