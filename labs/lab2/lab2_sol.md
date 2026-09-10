# Solución del reto — Práctica 2

## Tarea 5.1. Ejecutar una ventana de mantenimiento

### Paso 1. Verificar el estado inicial de `cka-worker1`

```bash
kubectl get nodes
```

Valida que `cka-worker1` aparezca:

```text
Ready
```

y que no muestre:

```text
SchedulingDisabled
```

También puedes confirmar:

```bash
kubectl describe node cka-worker1 | grep 'Unschedulable:'
```

Salida esperada:

```text
Unschedulable:      false
```

---

### Paso 2. Evitar nuevas asignaciones en `cka-worker1`

```bash
kubectl cordon cka-worker1
```

Valida:

```bash
kubectl get nodes
```

Salida esperada:

```text
cka-worker1   Ready,SchedulingDisabled
```

Confirma además:

```bash
kubectl describe node cka-worker1 | grep 'Unschedulable:'
```

Salida esperada:

```text
Unschedulable:      true
```

---

### Paso 3. Revisar qué Pods se ejecutan en el worker

```bash
kubectl get pods -A -o wide --field-selector spec.nodeName=cka-worker1
```

Identifica:

- Pods de `maintenance-app`.
- Pods administrados por DaemonSets, como `calico-node` y `kube-proxy`.
- Cualquier Pod independiente que pudiera bloquear el `drain`.

---

### Paso 4. Drenar `cka-worker1`

```bash
kubectl drain cka-worker1 --ignore-daemonsets
```

Si aparece un error indicando un Pod sin controlador, identifica primero el recurso:

```bash
kubectl get pod NOMBRE_DEL_POD -n NAMESPACE \
  -o jsonpath='{.metadata.ownerReferences}{"\n"}'
```

Si es un Pod temporal que puede eliminarse de forma segura:

```bash
kubectl delete pod NOMBRE_DEL_POD -n NAMESPACE
```

Repite:

```bash
kubectl drain cka-worker1 --ignore-daemonsets
```

No agregues `--force` automáticamente sin identificar primero qué bloquea el drenado.

---

### Paso 5. Verificar la reprogramación de la aplicación

```bash
kubectl get pods -n lab2 -l app=maintenance-app -o wide
```

Valida que las tres réplicas estén:

```text
Running
```

y que ya no estén ejecutándose en `cka-worker1`.

Comprueba además el Deployment:

```bash
kubectl get deployment maintenance-app -n lab2
```

La salida debe mostrar tres réplicas disponibles.

---

### Paso 6. Confirmar que los DaemonSets permanecen en el worker

```bash
kubectl get pods -A -o wide --field-selector spec.nodeName=cka-worker1
```

Deben continuar Pods como:

```text
calico-node
kube-proxy
```

porque son administrados mediante DaemonSets.

---

## Tarea 5.2. Restaurar el servicio

### Paso 7. Volver a habilitar el scheduling en `cka-worker1`

```bash
kubectl uncordon cka-worker1
```

Valida:

```bash
kubectl get nodes
```

Salida esperada:

```text
cka-worker1   Ready
```

sin `SchedulingDisabled`.

---

### Paso 8. Confirmar que el nodo volvió a ser schedulable

```bash
kubectl describe node cka-worker1 | grep 'Unschedulable:'
```

Salida esperada:

```text
Unschedulable:      false
```

---

### Paso 9. Generar nuevas réplicas de forma controlada

```bash
kubectl rollout restart deployment/maintenance-app -n lab2
```

Espera a que finalice:

```bash
kubectl rollout status deployment/maintenance-app -n lab2 --timeout=120s
```

---

### Paso 10. Comprobar que `cka-worker1` vuelve a participar en el scheduling

```bash
kubectl get pods -n lab2 -l app=maintenance-app -o wide
```

Las nuevas réplicas deberían volver a preferir `cka-worker1` debido a la afinidad configurada en el Deployment.

---

### Paso 11. Validar el estado final del clúster

```bash
kubectl get nodes
```

```bash
kubectl get deployment maintenance-app -n lab2
```

```bash
kubectl get pods -n lab2 -o wide
```

```bash
kubectl get --raw='/readyz'
```

Resultados esperados:

- `cka-control` en `Ready`.
- `cka-worker1` en `Ready`.
- Sin `SchedulingDisabled`.
- `maintenance-app` con 3 réplicas disponibles.
- Sin Pods `Pending`.
- API Server respondiendo:

```text
ok
```

---

### Paso 12. Limpiar los recursos de la práctica

Elimina el namespace:

```bash
kubectl delete namespace lab2
```

Elimina los archivos locales creados durante la práctica:

```bash
rm -f lab2-app.yaml lab2-cordon-test.yaml
```

Valida:

```bash
kubectl get namespace lab2
```

La respuesta esperada es un error `NotFound`.

Finalmente:

```bash
kubectl get nodes
```

El estado final debe conservar:

```text
cka-control   Ready
cka-worker1   Ready
```

`cka-worker2` debe continuar sin estar unido al clúster.
