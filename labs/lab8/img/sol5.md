# Solución — Práctica 8, Tarea 5

## Recuperar el almacenamiento de `storage-api`

Desde `cka-control`, revisa el estado del Pod y del PVC:

```bash
kubectl get pod,pvc -n exam-storage
```

Describe el PVC para identificar la causa del estado `Pending`:

```bash
kubectl describe pvc app-data -n exam-storage
```

Revisa las StorageClasses disponibles:

```bash
kubectl get storageclass
```

Revisa el PersistentVolume preparado para el escenario:

```bash
kubectl get pv lab8-pv
```

El problema está en la StorageClass solicitada por el PVC.

El PVC solicita:

```text
lab8-fast
```

pero el PV disponible utiliza:

```text
lab8-local
```

Como `storageClassName` es un campo inmutable del PVC, elimina primero el claim defectuoso:

```bash
kubectl delete pvc app-data -n exam-storage
```

Confirma que el PVC ya no existe:

```bash
kubectl get pvc app-data -n exam-storage
```

Resultado esperado:

```text
Error from server (NotFound)
```

Crea nuevamente el PVC con la StorageClass correcta:

```bash
cat > app-data-fixed.yaml <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
  namespace: exam-storage
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: lab8-local
  resources:
    requests:
      storage: 500Mi
EOF
```

Aplica el PVC corregido:

```bash
kubectl apply -f app-data-fixed.yaml
```

Valida el binding:

```bash
kubectl get pvc app-data -n exam-storage
```

Resultado esperado:

```text
STATUS   VOLUME
Bound    lab8-pv
```

Verifica también el PV:

```bash
kubectl get pv lab8-pv
```

Resultado esperado:

```text
STATUS   CLAIM
Bound    exam-storage/app-data
```

Espera a que el Pod existente complete su creación utilizando el PVC recreado:

```bash
kubectl wait   --for=condition=Ready   pod/storage-api   -n exam-storage   --timeout=90s
```

Resultado esperado:

```text
pod/storage-api condition met
```

Comprueba el contenido escrito en el volumen:

```bash
kubectl exec -n exam-storage storage-api --   cat /data/status.txt
```

Resultado esperado:

```text
storage-ready
```

Validación final:

```bash
kubectl get pod,pvc -n exam-storage
```

Resultado esperado:

```text
storage-api   1/1   Running
app-data      Bound
```
