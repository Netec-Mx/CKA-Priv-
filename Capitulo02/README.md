# 4 Práctica 2: Mantenimiento de nodos y reprogramación de cargas

## Metadatos

| Campo | Valor |
|---|---|
| Duración | 60 minutos |
| Complejidad | Media |
| Nivel de Bloom | Aplicar |

## Descripción general

En esta práctica se realizará una ventana de mantenimiento controlada sobre `worker1` usando `kubectl cordon`, `kubectl drain` y `kubectl uncordon`. Se crearán cargas gestionadas y no gestionadas, un DaemonSet y restricciones de scheduling mediante labels, `nodeSelector`, node affinity, taints y tolerations.

El objetivo operativo es comprobar qué Pods pueden evacuarse, cuáles requieren intervención administrativa y cómo Kubernetes reprograma las réplicas disponibles en `worker2` sin afectar innecesariamente la estabilidad del clúster.

## Objetivos de aprendizaje

Al finalizar la práctica, podrá:

- [ ] Aplicar `cordon`, `drain` y `uncordon` sobre un nodo worker de forma segura.
- [ ] Diferenciar Pods gestionados, Pods de DaemonSet, Pods no gestionados y Pods estáticos durante una evacuación.
- [ ] Programar cargas usando labels, `nodeSelector`, node affinity, taints y tolerations.
- [ ] Verificar la reprogramación de réplicas y el cumplimiento de un `PodDisruptionBudget`.
- [ ] Restaurar `worker1` y `worker2` a un estado operativo apto para prácticas posteriores.

## Prerrequisitos

### Conocimientos requeridos

- Administración básica de recursos Kubernetes con `kubectl`.
- Conceptos de `Deployment`, `ReplicaSet`, `DaemonSet`, `Pod`, labels y namespaces.
- Interpretación básica de `kubectl get`, `kubectl describe`, eventos y estados de Pods.
- Comprensión de recursos `allocatable`, solicitudes (`requests`) y condiciones de nodo.
- Práctica 1 completada y línea base del clúster disponible.

### Acceso requerido

- Contexto Kubernetes con permisos `cluster-admin`, preferiblemente `kubernetes-admin@kubernetes`.
- Acceso a los nodos `cp1`, `worker1` y `worker2`.
- Acceso SSH o de consola con privilegios `sudo`, si se requiere revisar un Pod estático en `cp1`.
- Acceso temporal al registro de contenedores o imágenes previamente disponibles en el runtime.

## Entorno de laboratorio

### Topología esperada

| Nodo | Dirección IP | Función |
|---|---:|---|
| `cp1` | `10.10.10.10` | Control plane |
| `worker1` | `10.10.10.11` | Nodo objetivo de mantenimiento |
| `worker2` | `10.10.10.12` | Nodo de reprogramación temporal |

### Versiones de referencia

| Componente | Versión |
|---|---|
| Kubernetes (`kubeadm`, `kubelet`, `kubectl`) | `1.31.6-1.1` |
| Container runtime | containerd `1.7.24-1` |
| CNI | Calico `3.29.2` |
| Imagen de diagnóstico | `busybox:1.36.1` |

> **Importante:** no ejecute esta práctica sobre el nodo de control `cp1`. El mantenimiento controlado se realizará exclusivamente sobre `worker1`.

### Preparación inicial

Ejecute los comandos desde una estación administrativa con `kubectl` configurado.

```bash
kubectl config current-context
kubectl get nodes -o wide
kubectl get pods -A -o wide
```

Compruebe las condiciones y la capacidad planificable de los workers:

```bash
kubectl describe node worker1
kubectl describe node worker2

kubectl get node worker1 -o jsonpath='{.status.allocatable.cpu}{" CPU, "}{.status.allocatable.memory}{" memoria\n"}'
kubectl get node worker2 -o jsonpath='{.status.allocatable.cpu}{" CPU, "}{.status.allocatable.memory}{" memoria\n"}'
```

Cree un directorio local para conservar evidencia reproducible:

```bash
mkdir -p ~/lab-02-00-01/evidencia
kubectl get nodes -o wide | tee ~/lab-02-00-01/evidencia/nodos-iniciales.txt
kubectl get pods -A -o wide | tee ~/lab-02-00-01/evidencia/pods-iniciales.txt
```

## Procedimiento paso a paso

### Paso 1. Validar la línea base operativa del clúster

**Objetivo:** confirmar que los nodos requeridos están disponibles, sin presión de recursos visible y con capacidad suficiente para reprogramar las cargas de la práctica.

**Instrucciones:**

1. Compruebe que los tres nodos se encuentran en estado `Ready`.

   ```bash
   kubectl get nodes
   ```

2. Revise las condiciones relevantes de `worker1` y `worker2`.

   ```bash
   kubectl describe node worker1 | sed -n '/Conditions:/,/Addresses:/p'
   kubectl describe node worker2 | sed -n '/Conditions:/,/Addresses:/p'
   ```

3. Revise las cargas ya presentes y sus ubicaciones.

   ```bash
   kubectl get pods -A -o wide
   ```

4. Revise los recursos asignables y los recursos solicitados en `worker2`, que será el nodo que recibirá las réplicas evacuadas.

   ```bash
   kubectl describe node worker2 | sed -n '/Allocatable:/,/Allocated resources:/p'
   kubectl describe node worker2 | sed -n '/Allocated resources:/,/Events:/p'
   ```

5. Guarde la inspección de ambos nodos como evidencia.

   ```bash
   kubectl describe node worker1 > ~/lab-02-00-01/evidencia/worker1-antes.txt
   kubectl describe node worker2 > ~/lab-02-00-01/evidencia/worker2-antes.txt
   ```

**Salida esperada:**

- `cp1`, `worker1` y `worker2` aparecen con estado `Ready`.
- Las condiciones `MemoryPressure`, `DiskPressure` y `PIDPressure` son `False`.
- `worker2` tiene recursos `Allocatable` suficientes para alojar las cargas de baja demanda de esta práctica.
- Los componentes de `kube-system`, como Calico, CoreDNS y kube-proxy, están en estado estable.

**Verificación:**

```bash
kubectl get nodes
kubectl get events -A --sort-by='.lastTimestamp' | tail -n 20
```

No continúe si `worker2` está en `NotReady`, tiene presión de disco o memoria, o presenta eventos críticos no resueltos.

---

### Paso 2. Crear el namespace y las cargas de mantenimiento

**Objetivo:** desplegar cargas que permitan observar el comportamiento de un `Deployment`, un `DaemonSet`, un `PodDisruptionBudget` y un Pod no gestionado durante un mantenimiento de nodo.

**Instrucciones:**

1. Cree el namespace de operaciones.

   ```bash
   kubectl create namespace operations
   ```

2. Etiquete `worker1` como nodo objetivo inicial del mantenimiento.

   ```bash
   kubectl label node worker1 training.example.io/maintenance-target=true
   ```

3. Verifique la label aplicada.

   ```bash
   kubectl get nodes -l training.example.io/maintenance-target=true --show-labels
   ```

4. Cree el manifiesto de las cargas de laboratorio.

   ```bash
   cat <<'EOF' > ~/lab-02-00-01/operaciones-inicial.yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: maintenance-api
     namespace: operations
     labels:
       app: maintenance-api
   spec:
     replicas: 3
     selector:
       matchLabels:
         app: maintenance-api
     template:
       metadata:
         labels:
           app: maintenance-api
       spec:
         nodeSelector:
           training.example.io/maintenance-target: "true"
         containers:
         - name: api
           image: busybox:1.36.1
           command:
           - /bin/sh
           - -c
           - "while true; do echo maintenance-api; sleep 30; done"
           resources:
             requests:
               cpu: 50m
               memory: 64Mi
             limits:
               cpu: 100m
               memory: 128Mi
   ---
   apiVersion: policy/v1
   kind: PodDisruptionBudget
   metadata:
     name: maintenance-api-pdb
     namespace: operations
   spec:
     minAvailable: 2
     selector:
       matchLabels:
         app: maintenance-api
   ---
   apiVersion: apps/v1
   kind: DaemonSet
   metadata:
     name: node-observer
     namespace: operations
     labels:
       app: node-observer
   spec:
     selector:
       matchLabels:
         app: node-observer
     template:
       metadata:
         labels:
           app: node-observer
       spec:
         containers:
         - name: observer
           image: busybox:1.36.1
           command:
           - /bin/sh
           - -c
           - "while true; do hostname; sleep 60; done"
           resources:
             requests:
               cpu: 25m
               memory: 32Mi
             limits:
               cpu: 50m
               memory: 64Mi
   ---
   apiVersion: v1
   kind: Pod
   metadata:
     name: manual-maintenance-pod
     namespace: operations
     labels:
       app: manual-maintenance-pod
   spec:
     nodeName: worker1
     restartPolicy: Always
     containers:
     - name: manual
       image: busybox:1.36.1
       command:
       - /bin/sh
       - -c
       - "while true; do echo unmanaged-pod; sleep 30; done"
       resources:
         requests:
           cpu: 25m
           memory: 32Mi
   EOF
   ```

5. Aplique los recursos.

   ```bash
   kubectl apply -f ~/lab-02-00-01/operaciones-inicial.yaml
   ```

6. Espere a que el `Deployment` complete su despliegue.

   ```bash
   kubectl -n operations rollout status deployment/maintenance-api --timeout=180s
   ```

**Salida esperada:**

- El `Deployment` `maintenance-api` dispone de tres réplicas.
- Las tres réplicas se programan inicialmente en `worker1` por el `nodeSelector`.
- El `DaemonSet` crea un Pod en cada worker elegible.
- El Pod `manual-maintenance-pod` se ejecuta en `worker1`, pero no posee un controlador que lo recree.
- El `PodDisruptionBudget` permite como máximo una interrupción voluntaria simultánea, manteniendo dos réplicas disponibles.

**Verificación:**

```bash
kubectl get all -n operations -o wide
kubectl get pdb -n operations
kubectl get pods -n operations -o wide
```

La ubicación esperada es conceptualmente similar a la siguiente:

```text
NAME                                      READY   STATUS    NODE
maintenance-api-xxxxxxxxxx-xxxxx          1/1     Running   worker1
maintenance-api-xxxxxxxxxx-xxxxx          1/1     Running   worker1
maintenance-api-xxxxxxxxxx-xxxxx          1/1     Running   worker1
manual-maintenance-pod                    1/1     Running   worker1
node-observer-xxxxx                       1/1     Running   worker1
node-observer-xxxxx                       1/1     Running   worker2
```

---

### Paso 3. Identificar Pods gestionados, DaemonSets, Pods no gestionados y Pods estáticos

**Objetivo:** distinguir los tipos de carga que afectan una operación de `drain`.

**Instrucciones:**

1. Liste los Pods de operaciones mostrando su nodo y controladores propietarios.

   ```bash
   kubectl get pods -n operations -o wide
   kubectl get pods -n operations -o custom-columns=\
   NAME:.metadata.name,\
   NODE:.spec.nodeName,\
   OWNER:.metadata.ownerReferences[0].kind,\
   OWNER_NAME:.metadata.ownerReferences[0].name
   ```

2. Inspeccione el Pod individual no gestionado.

   ```bash
   kubectl describe pod manual-maintenance-pod -n operations
   ```

3. Inspeccione el DaemonSet y sus Pods.

   ```bash
   kubectl get daemonset -n operations
   kubectl describe daemonset node-observer -n operations
   ```

4. Revise un Pod estático del control plane. En un clúster kubeadm, los Pods del API Server, scheduler, controller manager y etcd suelen ser Pods estáticos administrados por el kubelet de `cp1`.

   ```bash
   kubectl get pods -n kube-system -o wide
   kubectl describe pod kube-apiserver-cp1 -n kube-system | grep -E 'Name:|Node:|kubernetes.io/config.mirror'
   ```

5. Guarde el estado de las cargas antes de iniciar el mantenimiento.

   ```bash
   kubectl get pods -n operations -o wide \
     | tee ~/lab-02-00-01/evidencia/pods-antes-drain.txt
   kubectl get pdb -n operations -o yaml \
     > ~/lab-02-00-01/evidencia/pdb-antes-drain.yaml
   ```

**Salida esperada:**

- Los Pods `maintenance-api-*` son gestionados por un `ReplicaSet`, creado por el `Deployment`.
- Los Pods `node-observer-*` son gestionados por el `DaemonSet`.
- `manual-maintenance-pod` no muestra controlador propietario y no será recreado si se elimina.
- Los Pods estáticos del control plane muestran la anotación `kubernetes.io/config.mirror`; son representaciones en el API de manifiestos locales del kubelet.

**Verificación:**

```bash
kubectl get pod manual-maintenance-pod -n operations \
  -o jsonpath='{.metadata.ownerReferences}{"\n"}'

kubectl get pods -n operations \
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,OWNER:.metadata.ownerReferences[0].kind
```

> **Interpretación operativa:**
>
> - Un `Deployment` puede recrear Pods evacuados mediante su `ReplicaSet`.
> - Un `DaemonSet` no se evacúa con un `drain` normal; se conserva mientras el nodo exista y sea elegible.
> - Un Pod no gestionado requiere una decisión explícita: eliminarlo, migrarlo manualmente o usar `--force` si se acepta su pérdida.
> - Un Pod estático no se migra mediante `kubectl drain`; su origen es un manifiesto local del nodo, normalmente bajo `/etc/kubernetes/manifests/`.

---

### Paso 4. Validar scheduling con taints, tolerations y node affinity

**Objetivo:** impedir y permitir explícitamente el scheduling en `worker2` mediante el taint `maintenance=planned:NoSchedule`.

**Instrucciones:**

1. Agregue el taint temporal a `worker2`.

   ```bash
   kubectl taint node worker2 maintenance=planned:NoSchedule
   ```

2. Verifique el taint.

   ```bash
   kubectl describe node worker2 | sed -n '/Taints:/,/Unschedulable:/p'
   ```

3. Cree un Pod que requiera `worker2`, pero que no tenga toleration. El Pod debe permanecer en `Pending`.

   ```bash
   cat <<'EOF' | kubectl apply -f -
   apiVersion: v1
   kind: Pod
   metadata:
     name: blocked-no-toleration
     namespace: operations
     labels:
       app: blocked-no-toleration
   spec:
     nodeSelector:
       kubernetes.io/hostname: worker2
     containers:
     - name: blocked
       image: busybox:1.36.1
       command:
       - /bin/sh
       - -c
       - "sleep 3600"
       resources:
         requests:
           cpu: 25m
           memory: 32Mi
   EOF
   ```

4. Espere unos segundos y consulte los eventos del Pod.

   ```bash
   sleep 10
   kubectl describe pod blocked-no-toleration -n operations
   ```

5. Cree una carga tolerante al taint y restringida a `worker2` mediante node affinity obligatoria.

   ```bash
   cat <<'EOF' | kubectl apply -f -
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: tolerated-on-worker2
     namespace: operations
     labels:
       app: tolerated-on-worker2
   spec:
     replicas: 1
     selector:
       matchLabels:
         app: tolerated-on-worker2
     template:
       metadata:
         labels:
           app: tolerated-on-worker2
       spec:
         nodeSelector:
           kubernetes.io/os: linux
         affinity:
           nodeAffinity:
             requiredDuringSchedulingIgnoredDuringExecution:
               nodeSelectorTerms:
               - matchExpressions:
                 - key: kubernetes.io/hostname
                   operator: In
                   values:
                   - worker2
         tolerations:
         - key: maintenance
           operator: Equal
           value: planned
           effect: NoSchedule
         containers:
         - name: tolerated
           image: busybox:1.36.1
           command:
           - /bin/sh
           - -c
           - "while true; do echo tolerated-on-worker2; sleep 30; done"
           resources:
             requests:
               cpu: 25m
               memory: 32Mi
   EOF
   ```

6. Espere al despliegue y compruebe su ubicación.

   ```bash
   kubectl -n operations rollout status deployment/tolerated-on-worker2 --timeout=180s
   kubectl get pods -n operations -o wide
   ```

**Salida esperada:**

- `blocked-no-toleration` permanece en `Pending`.
- Sus eventos indican una causa similar a `untolerated taint {maintenance: planned}`.
- La réplica de `tolerated-on-worker2` se ejecuta en `worker2`.
- El Pod tolerante cumple simultáneamente el `nodeSelector`, la node affinity obligatoria y la toleration.

**Verificación:**

```bash
kubectl get pods -n operations -o wide
kubectl get events -n operations --sort-by='.lastTimestamp' | tail -n 20
```

La salida del Pod bloqueado debe incluir un evento semejante a:

```text
0/3 nodes are available: 1 node(s) had untolerated taint {maintenance: planned}, ...
```

---

### Paso 5. Preparar el Deployment para su evacuación hacia worker2

**Objetivo:** eliminar la restricción exclusiva hacia `worker1` y añadir la toleration necesaria para que las réplicas evacuadas puedan programarse en `worker2`.

**Instrucciones:**

1. Inspeccione el `nodeSelector` actual del `Deployment`.

   ```bash
   kubectl get deployment maintenance-api -n operations \
     -o jsonpath='{.spec.template.spec.nodeSelector}{"\n"}'
   ```

2. Actualice la plantilla de Pods del `Deployment`:

   - Elimine el `nodeSelector` que obliga a usar `worker1`.
   - Agregue toleration para `maintenance=planned:NoSchedule`.

   ```bash
   kubectl -n operations patch deployment maintenance-api \
     --type='merge' \
     -p '{
       "spec": {
         "template": {
           "spec": {
             "nodeSelector": null,
             "tolerations": [
               {
                 "key": "maintenance",
                 "operator": "Equal",
                 "value": "planned",
                 "effect": "NoSchedule"
               }
             ]
           }
         }
       }
     }'
   ```

3. Espere a que finalice el rollout provocado por el cambio de plantilla.

   ```bash
   kubectl -n operations rollout status deployment/maintenance-api --timeout=180s
   ```

4. Revise el estado del `PodDisruptionBudget`.

   ```bash
   kubectl get pdb maintenance-api-pdb -n operations
   ```

5. Consulte dónde se encuentran las réplicas antes de drenar el nodo.

   ```bash
   kubectl get pods -n operations -l app=maintenance-api -o wide
   ```

**Salida esperada:**

- El `Deployment` continúa con tres réplicas disponibles.
- La nueva plantilla no restringe las réplicas a `worker1`.
- Las réplicas pueden ejecutarse en `worker2` porque ahora toleran el taint temporal.
- El PDB indica que existen al menos dos Pods disponibles y que puede admitirse una interrupción voluntaria controlada.

**Verificación:**

```bash
kubectl get deployment maintenance-api -n operations
kubectl get pdb maintenance-api-pdb -n operations
kubectl get pods -n operations -l app=maintenance-api -o wide
```

> **Nota:** la actualización de la plantilla no garantiza que el scheduler redistribuya inmediatamente todos los Pods existentes. El scheduler actúa principalmente al crear Pods nuevos. Durante el `drain`, las réplicas evacuadas serán recreadas en nodos elegibles, especialmente en `worker2`.

---

### Paso 6. Aplicar cordon a worker1 y analizar el primer intento de drain

**Objetivo:** impedir nuevas asignaciones a `worker1` y observar cómo `drain` identifica obstáculos de evacuación.

**Instrucciones:**

1. Marque `worker1` como no programable.

   ```bash
   kubectl cordon worker1
   ```

2. Verifique el estado del nodo.

   ```bash
   kubectl get nodes
   kubectl describe node worker1 | grep -E 'Name:|Taints:|Unschedulable:'
   ```

3. Compruebe que el `DaemonSet` continúa presente en `worker1`. Un cordon impide nuevas asignaciones normales, pero no elimina Pods existentes.

   ```bash
   kubectl get pods -n operations -o wide
   ```

4. Ejecute un primer intento de evacuación sin opciones adicionales.

   ```bash
   kubectl drain worker1 --timeout=60s
   ```

5. Registre el resultado. No utilice todavía `--force`.

   ```bash
   kubectl get events -n operations --sort-by='.lastTimestamp' \
     | tee ~/lab-02-00-01/evidencia/eventos-primer-drain.txt
   ```

**Salida esperada:**

- `worker1` aparece como `Ready,SchedulingDisabled`.
- El primer `drain` informa que existen Pods de DaemonSet y que se requiere `--ignore-daemonsets`.
- También identifica el Pod no gestionado `manual-maintenance-pod`, que requiere una acción explícita o la opción `--force`.

La salida puede incluir mensajes conceptualmente similares a:

```text
cannot delete DaemonSet-managed Pods
cannot delete Pods that declare no controller
```

**Verificación:**

```bash
kubectl get nodes
kubectl get pods -n operations -o wide
```

> **Decisión administrativa:** no se utilizará `--force` en esta práctica. En producción, esta opción puede eliminar Pods no gestionados sin que exista un controlador que los reconstruya. En su lugar, se eliminará conscientemente el Pod manual y se ignorarán los Pods gestionados por el DaemonSet.

---

### Paso 7. Corregir los bloqueos y evacuar worker1 de forma controlada

**Objetivo:** completar el `drain` preservando los Pods de DaemonSet y permitiendo que el `Deployment` se reprograme conforme al PDB.

**Instrucciones:**

1. Elimine de forma explícita el Pod no gestionado. Documente que no será recreado.

   ```bash
   kubectl delete pod manual-maintenance-pod -n operations
   ```

2. Confirme que el Pod ya no existe.

   ```bash
   kubectl get pod manual-maintenance-pod -n operations
   ```

3. Ejecute el drain ignorando los Pods administrados por DaemonSet.

   ```bash
   kubectl drain worker1 \
     --ignore-daemonsets \
     --delete-emptydir-data \
     --timeout=5m
   ```

4. Mientras se ejecuta el drain, observe los Pods y los eventos en otra terminal.

   ```bash
   watch -n 2 'kubectl get pods -n operations -o wide'
   ```

   En una segunda terminal:

   ```bash
   kubectl get events -n operations --watch
   ```

5. Cuando finalice el drain, recopile evidencia de las cargas y del nodo.

   ```bash
   kubectl get pods -n operations -o wide \
     | tee ~/lab-02-00-01/evidencia/pods-despues-drain.txt

   kubectl describe node worker1 \
     > ~/lab-02-00-01/evidencia/worker1-despues-drain.txt

   kubectl get pdb maintenance-api-pdb -n operations \
     -o yaml > ~/lab-02-00-01/evidencia/pdb-despues-drain.yaml
   ```

**Salida esperada:**

- Los Pods gestionados por `maintenance-api` se eliminan de `worker1`.
- El `ReplicaSet` crea reemplazos, que se programan en `worker2` porque:
  - `worker1` está cordonado.
  - `worker2` es elegible.
  - La plantilla de `maintenance-api` contiene la toleration requerida.
- El `PodDisruptionBudget` limita las interrupciones para preservar al menos dos réplicas disponibles.
- El Pod `node-observer` de `worker1` permanece en ese nodo porque pertenece a un `DaemonSet`.
- El Pod `blocked-no-toleration` sigue en estado `Pending`.

**Verificación:**

```bash
kubectl get nodes
kubectl get pods -n operations -o wide
kubectl get deployment maintenance-api -n operations
kubectl get pdb maintenance-api-pdb -n operations
```

Compruebe específicamente que no quedan Pods evacuables de `maintenance-api` en `worker1`:

```bash
kubectl get pods -n operations \
  -l app=maintenance-api \
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
```

La ubicación esperada de las tres réplicas es `worker2`.

> **Nota sobre `--delete-emptydir-data`:** esta opción permite evacuar Pods que usan almacenamiento temporal `emptyDir`, aceptando su pérdida. No elimina datos de PVC. En un mantenimiento real, evalúe cuidadosamente si los datos temporales son recuperables antes de usarla.

---

### Paso 8. Simular el final del mantenimiento y restaurar la capacidad de scheduling

**Objetivo:** devolver `worker1` al pool de nodos programables y retirar la restricción temporal de `worker2`.

**Instrucciones:**

1. Simule la validación posterior al mantenimiento revisando el estado de `worker1`.

   ```bash
   kubectl get node worker1
   kubectl describe node worker1 | sed -n '/Conditions:/,/Addresses:/p'
   ```

2. Habilite nuevamente el scheduling en `worker1`.

   ```bash
   kubectl uncordon worker1
   ```

3. Retire el taint temporal de `worker2`.

   ```bash
   kubectl taint node worker2 maintenance=planned:NoSchedule-
   ```

4. Verifique ambos cambios.

   ```bash
   kubectl get nodes
   kubectl describe node worker2 | grep -E 'Name:|Taints:|Unschedulable:'
   ```

5. Elimine el Pod que se utilizó para demostrar el bloqueo por ausencia de toleration.

   ```bash
   kubectl delete pod blocked-no-toleration -n operations
   ```

6. Valide que la aplicación tolerante sigue funcionando en `worker2`.

   ```bash
   kubectl get pods -n operations -l app=tolerated-on-worker2 -o wide
   ```

**Salida esperada:**

- `worker1` deja de mostrar `SchedulingDisabled`.
- `worker2` ya no tiene el taint `maintenance=planned:NoSchedule`.
- `worker2` continúa como nodo `Ready` y elegible para futuras cargas, incluida la incorporación de `worker3` en la práctica posterior.
- Las tres réplicas de `maintenance-api` permanecen disponibles.

**Verificación:**

```bash
kubectl get nodes
kubectl get deployment -n operations
kubectl get pods -n operations -o wide
kubectl get events -n operations --sort-by='.lastTimestamp' | tail -n 25
```

## Validación y pruebas

Ejecute la siguiente secuencia final para validar el resultado funcional antes de la limpieza:

```bash
kubectl get nodes
kubectl get pods -n operations -o wide
kubectl get deployment -n operations
kubectl get daemonset -n operations
kubectl get pdb -n operations
```

Criterios de aceptación:

| Validación | Resultado esperado |
|---|---|
| Estado de nodos | `cp1`, `worker1` y `worker2` están en `Ready`. |
| Scheduling de `worker1` | No muestra `SchedulingDisabled`. |
| Taint temporal de `worker2` | No existe `maintenance=planned:NoSchedule`. |
| Deployment principal | `maintenance-api` tiene `3/3` réplicas disponibles. |
| PDB | `maintenance-api-pdb` mantiene al menos dos Pods disponibles durante la evacuación y recupera la disponibilidad total después de ella. |
| DaemonSet | `node-observer` conserva un Pod por worker elegible. |
| Pod no gestionado | `manual-maintenance-pod` fue eliminado conscientemente y no se recreó. |
| Scheduling con toleration | `tolerated-on-worker2` se ejecuta en `worker2`. |
| Evidencia | Existen archivos de estado, eventos y descripciones en `~/lab-02-00-01/evidencia/`. |

Ejecute además estas comprobaciones específicas:

```bash
kubectl get deployment maintenance-api -n operations \
  -o jsonpath='Disponibles={.status.availableReplicas} Deseadas={.spec.replicas}{"\n"}'

kubectl get node worker1 \
  -o jsonpath='worker1 unschedulable={.spec.unschedulable}{"\n"}'

kubectl get node worker2 \
  -o jsonpath='{.spec.taints}{"\n"}'
```

La salida esperada es similar a:

```text
Disponibles=3 Deseadas=3
worker1 unschedulable=
[]
```

## Resolución de problemas

### Incidencia 1: El drain queda bloqueado por un Pod no gestionado o por Pods de DaemonSet

**Síntomas:**

```text
cannot delete DaemonSet-managed Pods
cannot delete Pods that declare no controller
```

El comando `kubectl drain worker1` termina con error antes de evacuar las cargas esperadas.

**Causa:**

- El nodo contiene Pods creados por un `DaemonSet`, que Kubernetes no elimina automáticamente durante un drain.
- También contiene un Pod sin `ownerReferences`, como `manual-maintenance-pod`. Kubernetes evita eliminarlo sin confirmación explícita porque no existe un controlador que lo reconstruya.

**Corrección:**

1. Identifique los propietarios de los Pods:

   ```bash
   kubectl get pods -n operations \
     -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,OWNER:.metadata.ownerReferences[0].kind
   ```

2. Elimine o migre manualmente el Pod no gestionado si su pérdida está aprobada:

   ```bash
   kubectl delete pod manual-maintenance-pod -n operations
   ```

3. Ejecute el drain ignorando los DaemonSets:

   ```bash
   kubectl drain worker1 \
     --ignore-daemonsets \
     --delete-emptydir-data \
     --timeout=5m
   ```

No use `--force` como primera opción. Úselo únicamente si entiende que los Pods no gestionados pueden eliminarse y no requieren migración manual.

### Incidencia 2: Las réplicas evacuadas quedan en Pending después del drain

**Síntomas:**

Los Pods de `maintenance-api` aparecen en estado `Pending` y los eventos contienen mensajes como:

```text
0/3 nodes are available: node(s) had untolerated taint {maintenance: planned}
```

o:

```text
node(s) didn't match Pod's node affinity/selector
```

**Causa:**

- `worker1` está cordonado y ya no admite Pods nuevos.
- `worker2` tiene el taint `maintenance=planned:NoSchedule`.
- La carga evacuada no tiene una toleration compatible con el taint, o conserva un `nodeSelector` que exige `worker1`.
- También puede existir insuficiencia de recursos solicitados frente a `Allocatable` en `worker2`.

**Corrección:**

1. Revise restricciones y eventos:

   ```bash
   kubectl describe pod <pod-pending> -n operations
   kubectl get deployment maintenance-api -n operations -o yaml
   kubectl describe node worker2
   ```

2. Elimine el `nodeSelector` restrictivo y agregue la toleration necesaria:

   ```bash
   kubectl -n operations patch deployment maintenance-api \
     --type='merge' \
     -p '{
       "spec": {
         "template": {
           "spec": {
             "nodeSelector": null,
             "tolerations": [
               {
                 "key": "maintenance",
                 "operator": "Equal",
                 "value": "planned",
                 "effect": "NoSchedule"
               }
             ]
           }
         }
       }
     }'
   ```

3. Si no se requiere mantener el taint durante la evacuación, retírelo:

   ```bash
   kubectl taint node worker2 maintenance=planned:NoSchedule-
   ```

4. Espere la reconciliación y verifique:

   ```bash
   kubectl -n operations rollout status deployment/maintenance-api --timeout=180s
   kubectl get pods -n operations -o wide
   ```

## Limpieza

Ejecute la limpieza únicamente después de haber validado y documentado el comportamiento de la práctica.

1. Elimine las cargas del namespace de operaciones.

   ```bash
   kubectl delete namespace operations
   ```

2. Retire la label temporal de mantenimiento de `worker1`.

   ```bash
   kubectl label node worker1 training.example.io/maintenance-target-
   ```

3. Compruebe que `worker1` está habilitado para scheduling.

   ```bash
   kubectl uncordon worker1
   ```

4. Asegure que el taint temporal no permanece en `worker2`.

   ```bash
   kubectl taint node worker2 maintenance=planned:NoSchedule- 2>/dev/null || true
   ```

5. Valide el estado final de nodos y componentes del sistema.

   ```bash
   kubectl get nodes
   kubectl get pods -A -o wide
   ```

6. Conserve la evidencia local para revisión posterior.

   ```bash
   find ~/lab-02-00-01/evidencia -maxdepth 1 -type f -printf '%f\n'
   ```

## Resumen

En esta práctica aplicó una secuencia administrativa de mantenimiento de nodos: inspección, `cordon`, análisis de restricciones, `drain`, verificación de reprogramación y `uncordon`.

Puntos operativos principales:

- Un nodo `Ready` puede dejar de ser elegible para nuevas cargas cuando está cordonado o tiene taints.
- `kubectl drain` evacúa Pods gestionados cuando existe capacidad y scheduling válido en otros nodos.
- Los DaemonSets deben tratarse explícitamente con `--ignore-daemonsets`; no representan una carga convencional que deba evacuarse.
- Un Pod no gestionado no tiene controlador de reconstrucción y requiere una decisión administrativa antes de drenar.
- Los Pods estáticos son administrados por el kubelet desde manifiestos locales y no se migran mediante `kubectl drain`.
- Un `PodDisruptionBudget` protege disponibilidad durante interrupciones voluntarias, pero no sustituye la necesidad de capacidad suficiente en nodos alternativos.
- Taints y tolerations controlan elegibilidad; labels, `nodeSelector` y node affinity restringen la ubicación de las cargas.
- Tras el mantenimiento, es imprescindible retirar restricciones temporales y validar que los nodos siguen aptos para operaciones posteriores.

### Recursos opcionales

- [Kubernetes: Drenar un nodo de forma segura](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- [Kubernetes: Asignar Pods a nodos](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
- [Kubernetes: Taints y tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- [Kubernetes: PodDisruptionBudgets](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)
- [Kubernetes: DaemonSet](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/)
