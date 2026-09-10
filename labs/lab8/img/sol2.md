# Solución — Práctica 8, Tarea 2

## Recuperar `cka-worker2`

Desde `cka-control`:

```bash
kubectl get node cka-worker2
```

Conéctate al worker:

```bash
ssh control@cka-worker2
```

Revisa kubelet:

```bash
sudo systemctl status kubelet
```

El servicio debe aparecer detenido o inactivo.

Recupéralo:

```bash
sudo systemctl start kubelet
```

Valida:

```bash
sudo systemctl status kubelet
```

Resultado esperado:

```text
active (running)
```

Regresa al control-plane:

```bash
exit
```

Comprueba el nodo:

```bash
kubectl get node cka-worker2
```

Resultado esperado:

```text
cka-worker2   Ready
```

Validación adicional:

```bash
kubectl describe node cka-worker2
```

La condición debe mostrar:

```text
Ready   True
```
