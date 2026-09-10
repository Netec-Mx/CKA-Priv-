# Solución — Práctica 8, Tarea 4

## Recuperar `payments-svc`

Desde `cka-control`, revisa los Pods y el Service:

```bash
kubectl get pods -n exam-network
kubectl get svc -n exam-network
```

Revisa los EndpointSlices del Service:

```bash
kubectl get endpointslice   -n exam-network   -l kubernetes.io/service-name=payments-svc   -o wide
```

El problema está en el selector del Service.

Revisa el selector actual:

```bash
kubectl get service payments-svc   -n exam-network   -o jsonpath='{.spec.selector}{"\n"}'
```

Revisa las labels reales de los Pods:

```bash
kubectl get pods   -n exam-network   --show-labels
```

El Service tiene:

```text
app=payment
```

pero los Pods usan:

```text
app=payments
```

Corrige el selector:

```bash
kubectl patch service payments-svc   -n exam-network   --type=merge   -p '{"spec":{"selector":{"app":"payments"}}}'
```

Valida que reaparezcan los endpoints:

```bash
kubectl get endpointslice   -n exam-network   -l kubernetes.io/service-name=payments-svc   -o wide
```

Debe mostrar las IP de los Pods de `payments`.

Comprueba acceso real al Service:

```bash
kubectl run service-check   -n exam-network   --image=curlimages/curl:8.16.0   --restart=Never   --rm -i   -- curl -sS --max-time 5 http://payments-svc
```

Resultado esperado:

```text
<!DOCTYPE html>
<html>
...
<title>Welcome to nginx!</title>
...
```

Validación final:

```bash
kubectl get deployment payments -n exam-network
```

Resultado esperado:

```text
READY   UP-TO-DATE   AVAILABLE
2/2     2            2
```
