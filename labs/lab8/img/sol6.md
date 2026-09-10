# Solución — Práctica 8, Tarea 6

## Recuperar `kube-scheduler`

Desde `cka-control`, revisa el Pod de prueba:

```bash
kubectl get pod scheduler-check
```

Debe permanecer sin ser programado mientras el scheduler esté afectado.

Revisa el estado del scheduler desde Kubernetes:

```bash
kubectl get pod -n kube-system   -l component=kube-scheduler
```

Después revisa los contenedores locales del control plane:

```bash
sudo crictl ps -a --name kube-scheduler
```

Obtén el contenedor más reciente:

```bash
SCHEDULER_CONTAINER=$(sudo crictl ps -a   --name kube-scheduler   --latest   -q)
```

Revisa sus logs:

```bash
sudo crictl logs "$SCHEDULER_CONTAINER"
```

El problema está en el manifiesto:

```text
/etc/kubernetes/manifests/kube-scheduler.yaml
```

Revisa la configuración de kubeconfig:

```bash
sudo grep -- '--kubeconfig='   /etc/kubernetes/manifests/kube-scheduler.yaml
```

El valor incorrecto es:

```text
--kubeconfig=/etc/kubernetes/scheduler-lab8.conf
```

y debe ser:

```text
--kubeconfig=/etc/kubernetes/scheduler.conf
```

Corrige el manifiesto sin crear archivos temporales dentro de `/etc/kubernetes/manifests`:

```bash
sudo sed   's#--kubeconfig=/etc/kubernetes/scheduler-lab8.conf#--kubeconfig=/etc/kubernetes/scheduler.conf#'   /etc/kubernetes/manifests/kube-scheduler.yaml   > /tmp/kube-scheduler.yaml
```

Reemplaza el manifiesto:

```bash
sudo install -o root -g root -m 600   /tmp/kube-scheduler.yaml   /etc/kubernetes/manifests/kube-scheduler.yaml
```

Elimina el temporal:

```bash
rm -f /tmp/kube-scheduler.yaml
```

Kubelet detectará el cambio y recreará el static Pod.

Comprueba el scheduler:

```bash
sudo crictl ps --name kube-scheduler
```

Después valida desde Kubernetes:

```bash
kubectl get pod -n kube-system   -l component=kube-scheduler
```

Resultado esperado:

```text
kube-scheduler-cka-control   1/1   Running
```

Ahora espera a que el Pod creado durante el incidente sea programado:

```bash
kubectl wait   --for=condition=Ready   pod/scheduler-check   --timeout=90s
```

Resultado esperado:

```text
pod/scheduler-check condition met
```

Validación final:

```bash
kubectl get pod scheduler-check -o wide
```

El Pod debe aparecer:

```text
Running
```

y debe tener un nodo asignado.
