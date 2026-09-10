# Solución — Práctica 8, Tarea 3

## Recuperar el workload `reports`

Desde `cka-control`, revisa los Pods:

```bash
kubectl get pods -n exam-scheduling
```

Describe uno de los Pods `Pending`:

```bash
kubectl describe pod -n exam-scheduling   $(kubectl get pods -n exam-scheduling -o jsonpath='{.items[0].metadata.name}')
```

El problema está en el `nodeSelector` del Deployment, que apunta a un nodo inexistente:

```text
kubernetes.io/hostname: cka-worker99
```

Corrige el Deployment eliminando esa restricción:

```bash
kubectl patch deployment reports   -n exam-scheduling   --type=json   -p='[{"op":"remove","path":"/spec/template/spec/nodeSelector"}]'
```

Valida el rollout:

```bash
kubectl rollout status deployment/reports   -n exam-scheduling   --timeout=90s
```

Comprueba el resultado:

```bash
kubectl get deployment reports -n exam-scheduling
```

Resultado esperado:

```text
READY   UP-TO-DATE   AVAILABLE
2/2     2            2
```

Valida también los Pods:

```bash
kubectl get pods -n exam-scheduling -o wide
```

Los dos Pods de `reports` deben aparecer:

```text
Running
```
