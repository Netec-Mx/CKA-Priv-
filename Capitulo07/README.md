# 4 Práctica 7: Diagnóstico de almacenamiento persistente y StorageClass

## Metadatos

| Campo | Valor |
|---|---|
| Duración | 50 minutos |
| Complejidad | Media |
| Nivel de Bloom | Aplicar |

## Descripción general

En esta práctica se valida el ciclo de vida completo del almacenamiento persistente en Kubernetes: `StorageClass`, aprovisionamiento dinámico, `PersistentVolumeClaim` (PVC), `PersistentVolume` (PV), programación del Pod y montaje por kubelet. Se utilizará Rancher Local Path Provisioner `0.0.31` para crear almacenamiento local dinámico con política de reclamación `Retain` y modo de enlace `WaitForFirstConsumer`.

Antes de diagnosticar almacenamiento, se verificará que la conectividad de red y DNS creada en la práctica anterior permanece operativa. Después se reproducirán fallas controladas para diferenciar problemas de aprovisionamiento, binding, scheduling y montaje.

## Objetivos de aprendizaje

Al finalizar la práctica, podrá:

- [ ] Inspeccionar `StorageClass`, PVC, PV, eventos y logs del aprovisionador local.
- [ ] Crear una `StorageClass` con `reclaimPolicy: Retain` y `volumeBindingMode: WaitForFirstConsumer`.
- [ ] Validar el aprovisionamiento dinámico de un PVC y su montaje dentro de un Pod.
- [ ] Diagnosticar PVC en estado `Pending`, fallas de binding y Pods que referencian claims inexistentes.
- [ ] Confirmar que los datos persisten después de eliminar y recrear controladamente una carga de trabajo.

## Prerrequisitos

### Conocimientos requeridos

- Conceptos de `StorageClass`, `PersistentVolume`, `PersistentVolumeClaim`, `accessModes`, `reclaimPolicy` y `volumeBindingMode`.
- Uso de `kubectl get`, `kubectl describe`, `kubectl logs`, `kubectl exec` y consulta de eventos.
- Conocimiento básico de Pods, Deployments, namespaces y selectores.
- Comprensión de que el almacenamiento local está asociado físicamente a un nodo.

### Acceso requerido

- Permisos `cluster-admin`.
- Acceso administrativo a `cp1` y acceso SSH con `sudo` a `worker1` y `worker2`.
- Clúster Kubernetes `v1.31.6` operativo con Calico `3.29.2`.
- Práctica 6 completada, incluyendo los recursos:
  - Namespace `cka-net`.
  - Service `web-net`.
  - Pod `net-debug`.
  - CoreDNS funcional.
- Acceso temporal a Internet o a un repositorio interno con el manifiesto e imagen de Rancher Local Path Provisioner `v0.0.31`.

## Entorno del laboratorio

### Topología

| Nodo | Dirección IP | Función |
|---|---:|---|
| `cp1` | `10.10.10.10` | Control plane |
| `worker1` | `10.10.10.11` | Worker |
| `worker2` | `10.10.10.12` | Worker |

### Componentes relevantes

| Componente | Versión o configuración esperada |
|---|---|
| Kubernetes | `1.31.6-1.1` |
| Runtime | containerd `1.7.24-1` |
| CNI | Calico `3.29.2` |
| CoreDNS | `1.11.3` |
| Provisionador local | Rancher Local Path Provisioner `0.0.31` |
| Imagen de diagnóstico | BusyBox `1.36.1` |
| Namespace de almacenamiento | `cka-storage` |
| StorageClass objetivo | `lab-local-retain` |
| Provisionador | `rancher.io/local-path` |
| Política de reclamación | `Retain` |
| Modo de enlace | `WaitForFirstConsumer` |

### Preparación de la estación administrativa

Ejecute los comandos desde `cp1` o desde la estación administrativa que tenga acceso al archivo `kubeconfig` del clúster.

```bash
kubectl cluster-info
kubectl get nodes -o wide
kubectl get pods -A
```

Defina variables para reducir errores tipográficos durante la práctica:

```bash
export STORAGE_NS=cka-storage
export STORAGE_CLASS=lab-local-retain
export PVC_NAME=data-retain
```

**Resultado esperado**

- Los nodos `cp1`, `worker1` y `worker2` deben aparecer en estado `Ready`.
- Los Pods esenciales del sistema, incluidos CoreDNS, Calico y kube-proxy, deben estar en ejecución.

**Verificación**

```bash
kubectl get nodes
kubectl get pods -n kube-system
```

No continúe si algún worker está en estado `NotReady`, ya que el aprovisionamiento local y el montaje de volúmenes dependen de kubelet y del estado del nodo seleccionado.

---

## Procedimiento paso a paso

### Paso 1. Validar la conectividad de red y DNS previa

**Objetivo:** confirmar que la conectividad básica entre Pods y Services sigue operativa antes de atribuir un síntoma a almacenamiento.

#### Instrucciones

1. Compruebe que los recursos de la práctica de red existen:

   ```bash
   kubectl get pod,svc,endpoints -n cka-net
   ```

2. Revise el estado de `net-debug` y `web-net`:

   ```bash
   kubectl get pod net-debug -n cka-net -o wide
   kubectl get svc web-net -n cka-net
   kubectl get endpoints web-net -n cka-net
   ```

3. Desde `net-debug`, resuelva el nombre DNS del Service:

   ```bash
   kubectl exec -n cka-net net-debug -- nslookup web-net
   ```

4. Pruebe conectividad HTTP hacia el Service:

   ```bash
   kubectl exec -n cka-net net-debug -- wget -S -O- http://web-net
   ```

5. Consulte los eventos recientes del namespace:

   ```bash
   kubectl get events -n cka-net --sort-by=.lastTimestamp
   ```

**Resultado esperado**

- `net-debug` debe estar en estado `Running`.
- `web-net` debe tener una dirección `ClusterIP`.
- El Service debe tener al menos un endpoint disponible.
- `nslookup web-net` debe devolver una dirección dentro del CIDR de Services `10.96.0.0/12`.
- La solicitud HTTP debe recibir una respuesta del backend de `web-net`.

**Verificación**

Documente la evidencia mínima:

```bash
kubectl get pod net-debug -n cka-net -o wide
kubectl get svc,endpoints web-net -n cka-net
kubectl exec -n cka-net net-debug -- nslookup web-net
```

> Si esta validación falla, diagnostique primero CoreDNS, endpoints, kube-proxy, Calico o conectividad entre nodos. La práctica de almacenamiento presupone una red base funcional.

---

### Paso 2. Instalar o verificar Rancher Local Path Provisioner

**Objetivo:** asegurar que existe un aprovisionador dinámico local operativo y que utiliza la versión fijada `0.0.31`.

Rancher Local Path Provisioner crea directorios locales en el nodo seleccionado para el Pod consumidor. Por esta razón, los datos quedan asociados al nodo donde se aprovisionó el volumen. Este enfoque es adecuado para el laboratorio, pero no sustituye un backend compartido, replicado o tolerante a fallos.

#### Instrucciones

1. Inspeccione si el namespace y el Deployment del provisionador ya existen:

   ```bash
   kubectl get namespace local-path-storage
   kubectl get deployment -n local-path-storage
   kubectl get pods -n local-path-storage -o wide
   ```

2. Si el provisionador no existe, aplique el manifiesto fijo de la versión `0.0.31`:

   ```bash
   kubectl apply -f \
     https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.31/deploy/local-path-storage.yaml
   ```

   Si el laboratorio utiliza un repositorio interno, sustituya la URL anterior por la ubicación interna que entregue exactamente el mismo manifiesto y la misma versión.

3. Espere a que el Deployment esté disponible:

   ```bash
   kubectl rollout status deployment/local-path-provisioner \
     -n local-path-storage \
     --timeout=180s
   ```

4. Verifique la imagen del contenedor del provisionador:

   ```bash
   kubectl get deployment local-path-provisioner \
     -n local-path-storage \
     -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'
   ```

5. Revise el ConfigMap del provisionador para identificar la ruta local configurada:

   ```bash
   kubectl get configmap local-path-config \
     -n local-path-storage \
     -o yaml
   ```

6. Consulte las StorageClass existentes antes de crear la clase del laboratorio:

   ```bash
   kubectl get storageclass
   kubectl get storageclass -o wide
   ```

**Resultado esperado**

- Debe existir el namespace `local-path-storage`.
- El Pod `local-path-provisioner` debe estar en estado `Running`.
- La imagen debe corresponder a `rancher/local-path-provisioner:v0.0.31`.
- El ConfigMap debe contener una configuración de rutas por nodo, normalmente bajo `/opt/local-path-provisioner`.
- Puede existir una StorageClass denominada `local-path`; no se utilizará como clase principal de esta práctica.

**Verificación**

```bash
kubectl get pods -n local-path-storage -o wide
kubectl logs deployment/local-path-provisioner \
  -n local-path-storage \
  --tail=30
```

La salida de logs no debe mostrar errores repetitivos de autenticación, permisos, creación de helper Pods o comunicación con el API Server.

---

### Paso 3. Crear e inspeccionar la StorageClass con política Retain

**Objetivo:** definir una política de almacenamiento reutilizable que aprovisione volúmenes locales dinámicos, conserve los datos al eliminar un PVC y espere a que exista un consumidor antes de seleccionar el nodo.

#### Instrucciones

1. Cree el manifiesto de la StorageClass:

   ```bash
   cat <<'EOF' > lab-local-retain-sc.yaml
   apiVersion: storage.k8s.io/v1
   kind: StorageClass
   metadata:
     name: lab-local-retain
   provisioner: rancher.io/local-path
   reclaimPolicy: Retain
   allowVolumeExpansion: false
   volumeBindingMode: WaitForFirstConsumer
   EOF
   ```

2. Aplique el manifiesto:

   ```bash
   kubectl apply -f lab-local-retain-sc.yaml
   ```

3. Inspeccione la StorageClass:

   ```bash
   kubectl get storageclass lab-local-retain -o wide
   kubectl describe storageclass lab-local-retain
   ```

4. Confirme que no se marcó accidentalmente como clase predeterminada:

   ```bash
   kubectl get storageclass lab-local-retain \
     -o jsonpath='{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}{"\n"}'
   ```

**Resultado esperado**

La StorageClass debe mostrar valores equivalentes a los siguientes:

```text
NAME               PROVISIONER              RECLAIMPOLICY   VOLUMEBINDINGMODE      ALLOWVOLUMEEXPANSION
lab-local-retain   rancher.io/local-path    Retain          WaitForFirstConsumer   false
```

**Verificación**

```bash
kubectl get sc lab-local-retain -o yaml
```

Confirme especialmente:

```yaml
provisioner: rancher.io/local-path
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
```

> `Retain` evita que el PV y los datos se eliminen automáticamente al borrar el PVC. No equivale a una copia de seguridad.  
> `WaitForFirstConsumer` permite que el scheduler seleccione un nodo antes de que el aprovisionador cree el volumen local en ese nodo.

---

### Paso 4. Crear un PVC y observar el estado WaitForFirstConsumer

**Objetivo:** crear una solicitud de almacenamiento de `1Gi` y reconocer que un PVC puede permanecer temporalmente en `Pending` sin representar una falla.

#### Instrucciones

1. Cree el namespace de trabajo:

   ```bash
   kubectl create namespace "${STORAGE_NS}" --dry-run=client -o yaml | kubectl apply -f -
   ```

2. Cree el PVC `data-retain`:

   ```bash
   cat <<'EOF' > data-retain-pvc.yaml
   apiVersion: v1
   kind: PersistentVolumeClaim
   metadata:
     name: data-retain
     namespace: cka-storage
   spec:
     accessModes:
       - ReadWriteOnce
     storageClassName: lab-local-retain
     resources:
       requests:
         storage: 1Gi
   EOF
   ```

3. Aplique el PVC:

   ```bash
   kubectl apply -f data-retain-pvc.yaml
   ```

4. Inspeccione inmediatamente el estado del PVC:

   ```bash
   kubectl get pvc -n "${STORAGE_NS}"
   kubectl describe pvc "${PVC_NAME}" -n "${STORAGE_NS}"
   ```

5. Revise los eventos del namespace:

   ```bash
   kubectl get events -n "${STORAGE_NS}" --sort-by=.lastTimestamp
   ```

**Resultado esperado**

Antes de crear un Pod consumidor, el PVC puede permanecer en estado `Pending`. En los eventos o en la descripción puede aparecer un mensaje similar a:

```text
WaitForFirstConsumer
waiting for first consumer to be created before binding
```

**Verificación**

```bash
kubectl get pvc data-retain -n cka-storage
kubectl describe pvc data-retain -n cka-storage
```

El estado `Pending` en este punto es esperado porque la StorageClass utiliza `WaitForFirstConsumer`. No diagnostique este estado como una falla de aprovisionamiento todavía.

---

### Paso 5. Crear el Deployment writer y validar binding, PV y montaje

**Objetivo:** consumir el PVC desde un Pod, activar el aprovisionamiento dinámico y validar que el volumen está montado y es escribible.

#### Instrucciones

1. Cree el manifiesto del Deployment:

   ```bash
   cat <<'EOF' > writer-deployment.yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: writer
     namespace: cka-storage
   spec:
     replicas: 1
     selector:
       matchLabels:
         app: writer
     template:
       metadata:
         labels:
           app: writer
       spec:
         containers:
           - name: writer
             image: busybox:1.36.1
             command:
               - /bin/sh
               - -c
               - |
                 if [ ! -f /data/lab-state.txt ]; then
                   echo "marca-creada=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /data/lab-state.txt
                   echo "nodo-inicial=$(hostname)" >> /data/lab-state.txt
                 fi
                 echo "writer activo en $(hostname)"
                 sleep 3600
             volumeMounts:
               - name: data
                 mountPath: /data
         volumes:
           - name: data
             persistentVolumeClaim:
               claimName: data-retain
   EOF
   ```

2. Aplique el Deployment:

   ```bash
   kubectl apply -f writer-deployment.yaml
   ```

3. Espere a que el Deployment esté disponible:

   ```bash
   kubectl rollout status deployment/writer \
     -n "${STORAGE_NS}" \
     --timeout=180s
   ```

4. Identifique el Pod y el nodo asignado:

   ```bash
   export WRITER_POD=$(kubectl get pods -n "${STORAGE_NS}" \
     -l app=writer \
     -o jsonpath='{.items[0].metadata.name}')

   kubectl get pod "${WRITER_POD}" -n "${STORAGE_NS}" -o wide
   ```

5. Verifique el PVC y obtenga el nombre del PV asociado:

   ```bash
   kubectl get pvc "${PVC_NAME}" -n "${STORAGE_NS}"
   export PV_NAME=$(kubectl get pvc "${PVC_NAME}" -n "${STORAGE_NS}" \
     -o jsonpath='{.spec.volumeName}')

   echo "${PV_NAME}"
   kubectl get pv "${PV_NAME}"
   kubectl describe pv "${PV_NAME}"
   ```

6. Inspeccione el montaje dentro del contenedor:

   ```bash
   kubectl exec -n "${STORAGE_NS}" "${WRITER_POD}" -- mount | grep ' /data '
   kubectl exec -n "${STORAGE_NS}" "${WRITER_POD}" -- df -h /data
   kubectl exec -n "${STORAGE_NS}" "${WRITER_POD}" -- ls -la /data
   kubectl exec -n "${STORAGE_NS}" "${WRITER_POD}" -- cat /data/lab-state.txt
   ```

7. Escriba una segunda marca de validación:

   ```bash
   kubectl exec -n "${STORAGE_NS}" "${WRITER_POD}" -- \
     sh -c 'echo "validacion=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /data/lab-state.txt'

   kubectl exec -n "${STORAGE_NS}" "${WRITER_POD}" -- cat /data/lab-state.txt
   ```

8. Inspeccione la descripción completa del Pod:

   ```bash
   kubectl describe pod "${WRITER_POD}" -n "${STORAGE_NS}"
   ```

**Resultado esperado**

- El Deployment `writer` debe tener `1/1` réplicas disponibles.
- El PVC `data-retain` debe cambiar a estado `Bound`.
- Debe crearse un PV cuyo nombre normalmente comienza por `pvc-`.
- El PV debe usar la StorageClass `lab-local-retain`.
- El comando `mount` debe mostrar un montaje en `/data`.
- El archivo `/data/lab-state.txt` debe existir y contener las marcas creadas.
- En `kubectl describe pod`, la sección `Volumes` debe mostrar que `data` usa el claim `data-retain`.

**Verificación**

```bash
kubectl get deployment,pod,pvc -n cka-storage -o wide
kubectl get pv "${PV_NAME}" -o wide
kubectl exec -n cka-storage "${WRITER_POD}" -- cat /data/lab-state.txt
kubectl describe pod "${WRITER_POD}" -n cka-storage
```

---

### Paso 6. Correlacionar el volumen con el nodo, kubelet y el provisionador

**Objetivo:** identificar dónde se creó el volumen local y recopilar evidencia desde Kubernetes, el provisionador y el nodo seleccionado.

#### Instrucciones

1. Obtenga el nodo asignado al Pod:

   ```bash
   export WRITER_NODE=$(kubectl get pod "${WRITER_POD}" \
     -n "${STORAGE_NS}" \
     -o jsonpath='{.spec.nodeName}')

   echo "${WRITER_NODE}"
   ```

2. Revise la afinidad de nodo y el origen local del PV:

   ```bash
   kubectl get pv "${PV_NAME}" -o yaml
   ```

3. Consulte los eventos relacionados con PVC, Pod y aprovisionamiento:

   ```bash
   kubectl describe pvc "${PVC_NAME}" -n "${STORAGE_NS}"
   kubectl describe pod "${WRITER_POD}" -n "${STORAGE_NS}"
   kubectl get events -n "${STORAGE_NS}" --sort-by=.lastTimestamp
   ```

4. Revise los logs del provisionador:

   ```bash
   kubectl logs deployment/local-path-provisioner \
     -n local-path-storage \
     --tail=100
   ```

5. Conéctese por SSH al worker identificado. Sustituya `<usuario>` por el usuario administrativo del laboratorio:

   ```bash
   ssh <usuario>@${WRITER_NODE}
   ```

6. En el worker, valide el estado de kubelet y busque directorios del provisionador:

   ```bash
   sudo systemctl status kubelet --no-pager
   sudo journalctl -u kubelet --since "30 minutes ago" --no-pager | tail -n 100
   sudo find /opt/local-path-provisioner -maxdepth 4 -type d 2>/dev/null
   ```

7. Si la ruta configurada en el ConfigMap no es `/opt/local-path-provisioner`, use la ruta real obtenida en el Paso 2.

8. Desde el worker, inspeccione montajes y espacio disponible:

   ```bash
   mount | grep -E 'kubelet|local-path'
   df -h
   ```

**Resultado esperado**

- El PV debe contener información de `nodeAffinity` o una referencia al nodo donde reside el almacenamiento.
- El Pod `writer` debe estar programado en uno de los workers.
- Los logs del provisionador deben incluir acciones relacionadas con la creación del volumen.
- Kubelet debe estar en estado activo.
- Debe existir un directorio local administrado por el provisionador en el nodo seleccionado.

**Verificación**

Registre la correlación siguiente:

| Evidencia | Valor observado |
|---|---|
| Pod consumidor | Nombre de `${WRITER_POD}` |
| Nodo seleccionado | Valor de `${WRITER_NODE}` |
| PVC | `data-retain` |
| PV asociado | Valor de `${PV_NAME}` |
| Estado del PVC | `Bound` |
| Estado del Pod | `Running` |
| Archivo persistente | `/data/lab-state.txt` |
| Servicio del nodo | `kubelet` activo |

> En un provisionador local, el nodo es parte de la identidad operativa del volumen. Si el nodo deja de estar disponible, el volumen no puede utilizarse desde un nodo diferente como si fuera almacenamiento compartido.

---

### Paso 7. Diagnosticar fallas controladas de StorageClass, compatibilidad y claim inexistente

**Objetivo:** distinguir entre una falla de selección de StorageClass, una solicitud de acceso no compatible con almacenamiento local y un error de referencia de PVC en un Pod.

#### Instrucciones

1. Cree un PVC que referencia una StorageClass inexistente:

   ```bash
   cat <<'EOF' > pvc-storageclass-inexistente.yaml
   apiVersion: v1
   kind: PersistentVolumeClaim
   metadata:
     name: pvc-sc-inexistente
     namespace: cka-storage
   spec:
     accessModes:
       - ReadWriteOnce
     storageClassName: clase-que-no-existe
     resources:
       requests:
         storage: 1Gi
   EOF

   kubectl apply -f pvc-storageclass-inexistente.yaml
   ```

2. Inspeccione el PVC y sus eventos:

   ```bash
   kubectl get pvc pvc-sc-inexistente -n cka-storage
   kubectl describe pvc pvc-sc-inexistente -n cka-storage
   kubectl get events -n cka-storage --sort-by=.lastTimestamp
   ```

3. Cree un PVC con modo de acceso `ReadWriteMany`, no adecuado para el uso multi-nodo de un backend local basado en directorios de nodo:

   ```bash
   cat <<'EOF' > pvc-rwx-local.yaml
   apiVersion: v1
   kind: PersistentVolumeClaim
   metadata:
     name: pvc-rwx-local
     namespace: cka-storage
   spec:
     accessModes:
       - ReadWriteMany
     storageClassName: lab-local-retain
     resources:
       requests:
         storage: 1Gi
   EOF

   kubectl apply -f pvc-rwx-local.yaml
   ```

4. Cree un Pod consumidor para forzar el proceso de binding de este PVC:

   ```bash
   cat <<'EOF' > pod-rwx-local.yaml
   apiVersion: v1
   kind: Pod
   metadata:
     name: consumer-rwx-local
     namespace: cka-storage
   spec:
     containers:
       - name: consumer
         image: busybox:1.36.1
         command: ["/bin/sh", "-c", "sleep 600"]
         volumeMounts:
           - name: data
             mountPath: /data
     volumes:
       - name: data
         persistentVolumeClaim:
           claimName: pvc-rwx-local
   EOF

   kubectl apply -f pod-rwx-local.yaml
   ```

5. Consulte el estado y los eventos:

   ```bash
   kubectl get pod,pvc -n cka-storage
   kubectl describe pvc pvc-rwx-local -n cka-storage
   kubectl describe pod consumer-rwx-local -n cka-storage
   kubectl get events -n cka-storage --sort-by=.lastTimestamp
   ```

6. Revise los logs del provisionador para determinar si rechazó la solicitud:

   ```bash
   kubectl logs deployment/local-path-provisioner \
     -n local-path-storage \
     --tail=100
   ```

7. Cree un Pod que referencia un claim inexistente:

   ```bash
   cat <<'EOF' > pod-claim-inexistente.yaml
   apiVersion: v1
   kind: Pod
   metadata:
     name: consumer-claim-inexistente
     namespace: cka-storage
   spec:
     containers:
       - name: consumer
         image: busybox:1.36.1
         command: ["/bin/sh", "-c", "sleep 600"]
         volumeMounts:
           - name: missing-data
             mountPath: /data
     volumes:
       - name: missing-data
         persistentVolumeClaim:
           claimName: claim-no-existe
   EOF

   kubectl apply -f pod-claim-inexistente.yaml
   ```

8. Describa el Pod y consulte los eventos:

   ```bash
   kubectl get pod consumer-claim-inexistente -n cka-storage
   kubectl describe pod consumer-claim-inexistente -n cka-storage
   kubectl get events -n cka-storage --sort-by=.lastTimestamp
   ```

**Resultado esperado**

Para `pvc-sc-inexistente`:

- El PVC debe permanecer en `Pending`.
- La descripción o los eventos deben indicar que no existe la StorageClass solicitada o que no hay aprovisionador disponible para esa clase.

Para `pvc-rwx-local`:

- El PVC o el Pod consumidor puede permanecer en `Pending`, o el provisionador puede registrar un rechazo de la solicitud.
- Debe quedar documentado que `ReadWriteMany` no convierte un directorio local de un nodo en almacenamiento compartido multi-nodo.
- Un almacenamiento local debe utilizarse normalmente con `ReadWriteOnce` cuando el volumen se consume desde una carga programada en un único nodo.

Para `consumer-claim-inexistente`:

- El Pod no debe llegar a `Running`.
- Los eventos deben indicar que el PVC `claim-no-existe` no fue encontrado o no puede ser usado.
- Esta falla ocurre antes de que la aplicación pueda ejecutar su proceso principal.

**Verificación**

Clasifique las fallas observadas:

| Recurso | Capa afectada | Evidencia principal |
|---|---|---|
| `pvc-sc-inexistente` | Selección de StorageClass / aprovisionamiento | `kubectl describe pvc` y eventos |
| `pvc-rwx-local` | Compatibilidad de acceso / binding / semántica del backend | Eventos, logs del provisionador y estado del Pod |
| `consumer-claim-inexistente` | Referencia de volumen / scheduling | `kubectl describe pod` y eventos |

> Un PVC `Pending` no siempre es una falla. Con `WaitForFirstConsumer`, puede ser un estado normal hasta que exista un Pod consumidor. La causa se determina revisando el PVC, los eventos, la StorageClass y el Pod asociado.

---

### Paso 8. Validar persistencia mediante recreación controlada del Deployment

**Objetivo:** comprobar que los datos sobreviven a la eliminación y recreación de la carga de trabajo mientras el PVC y el PV permanecen intactos.

#### Instrucciones

1. Obtenga el contenido actual del archivo persistente:

   ```bash
   kubectl exec -n "${STORAGE_NS}" "${WRITER_POD}" -- cat /data/lab-state.txt
   ```

2. Elimine únicamente el Deployment, no el PVC:

   ```bash
   kubectl delete deployment writer -n "${STORAGE_NS}"
   ```

3. Espere a que desaparezca el Pod anterior:

   ```bash
   kubectl wait --for=delete pod/"${WRITER_POD}" \
     -n "${STORAGE_NS}" \
     --timeout=120s
   ```

4. Confirme que PVC y PV siguen existiendo y permanecen enlazados:

   ```bash
   kubectl get pvc "${PVC_NAME}" -n "${STORAGE_NS}"
   kubectl get pv "${PV_NAME}"
   ```

5. Recree el Deployment con el mismo manifiesto:

   ```bash
   kubectl apply -f writer-deployment.yaml
   kubectl rollout status deployment/writer \
     -n "${STORAGE_NS}" \
     --timeout=180s
   ```

6. Obtenga el nuevo nombre de Pod:

   ```bash
   export WRITER_POD=$(kubectl get pods -n "${STORAGE_NS}" \
     -l app=writer \
     -o jsonpath='{.items[0].metadata.name}')

   kubectl get pod "${WRITER_POD}" -n "${STORAGE_NS}" -o wide
   ```

7. Compruebe que el archivo y sus marcas originales persisten:

   ```bash
   kubectl exec -n "${STORAGE_NS}" "${WRITER_POD}" -- cat /data/lab-state.txt
   kubectl exec -n "${STORAGE_NS}" "${WRITER_POD}" -- df -h /data
   kubectl describe pod "${WRITER_POD}" -n "${STORAGE_NS}"
   ```

**Resultado esperado**

- El nuevo Pod puede tener un nombre distinto, pero debe montar el mismo PVC `data-retain`.
- El PVC debe continuar en estado `Bound`.
- El PV asociado debe conservarse.
- El archivo `/data/lab-state.txt` debe contener la marca inicial y la marca de validación creadas antes de eliminar el Deployment.
- El scheduler debe respetar la afinidad del volumen local y programar el consumidor en un nodo compatible con el PV.

**Verificación**

```bash
kubectl get deployment,pod,pvc -n cka-storage -o wide
kubectl get pv "${PV_NAME}" -o wide
kubectl exec -n cka-storage "${WRITER_POD}" -- cat /data/lab-state.txt
```

---

## Validación y pruebas finales

Ejecute la siguiente secuencia para confirmar la línea base que se conservará para la práctica posterior:

```bash
kubectl get storageclass lab-local-retain -o wide
kubectl get deployment,pod,pvc -n cka-storage -o wide
kubectl get pv -o wide
kubectl get events -n cka-storage --sort-by=.lastTimestamp
```

La validación final es satisfactoria si se cumplen todos los criterios siguientes:

| Criterio | Resultado esperado |
|---|---|
| Red y DNS de la práctica 6 | `net-debug` resuelve y alcanza `web-net` |
| Provisionador | `local-path-provisioner` en `Running` |
| StorageClass | Existe `lab-local-retain` con `Retain` y `WaitForFirstConsumer` |
| PVC principal | `data-retain` en estado `Bound` |
| PV principal | Asociado a `data-retain` y conservado |
| Deployment principal | `writer` con `1/1` réplicas disponibles |
| Montaje | `/data` montado dentro del Pod `writer` |
| Escritura | `/data/lab-state.txt` existe y puede leerse |
| Persistencia | El archivo permanece después de recrear `writer` |
| Evidencia operativa | Eventos, descripción de PVC/PV/Pod y logs del provisionador revisados |

Comando compacto de comprobación:

```bash
kubectl get sc lab-local-retain
kubectl get pvc data-retain -n cka-storage
kubectl get deployment writer -n cka-storage
kubectl exec -n cka-storage "${WRITER_POD}" -- cat /data/lab-state.txt
```

## Solución de problemas

### Incidencia 1. El PVC `data-retain` permanece en `Pending`

**Síntomas**

```bash
kubectl get pvc data-retain -n cka-storage
```

Muestra:

```text
NAME          STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS       AGE
data-retain   Pending                                      lab-local-retain   5m
```

Los eventos pueden incluir:

```text
waiting for first consumer to be created before binding
```

o mensajes de fallo de aprovisionamiento.

**Causa**

Con `volumeBindingMode: WaitForFirstConsumer`, es normal que el PVC permanezca pendiente antes de crear un Pod consumidor. Si el Deployment `writer` ya existe y el PVC continúa pendiente, las causas probables son:

- El Pod no puede ser programado por falta de nodos `Ready`, taints, recursos insuficientes o restricciones de afinidad.
- El provisionador `local-path-provisioner` no está disponible.
- La StorageClass tiene un nombre, provisionador o configuración incorrectos.
- El provisionador no puede crear directorios en la ruta local configurada.

**Corrección**

1. Verifique que existe un consumidor y que puede programarse:

   ```bash
   kubectl get pods -n cka-storage -o wide
   kubectl describe pod "${WRITER_POD}" -n cka-storage
   kubectl get nodes
   ```

2. Valide la StorageClass:

   ```bash
   kubectl describe storageclass lab-local-retain
   ```

3. Revise el provisionador:

   ```bash
   kubectl get pods -n local-path-storage -o wide
   kubectl logs deployment/local-path-provisioner \
     -n local-path-storage \
     --tail=100
   ```

4. Consulte los eventos del PVC:

   ```bash
   kubectl describe pvc data-retain -n cka-storage
   kubectl get events -n cka-storage --sort-by=.lastTimestamp
   ```

No elimine el PVC principal sin haber recopilado la evidencia de eventos y logs necesaria para determinar si la causa está en scheduling, aprovisionamiento o configuración.

### Incidencia 2. El Pod `writer` está en `ContainerCreating` o no monta `/data`

**Síntomas**

```bash
kubectl get pod -n cka-storage -l app=writer
kubectl describe pod -n cka-storage -l app=writer
```

El Pod puede mostrar eventos similares a:

```text
FailedMount
MountVolume.SetUp failed
Unable to attach or mount volumes
```

o permanecer en estado `ContainerCreating`.

**Causa**

El PVC ya puede estar en `Bound`, pero kubelet todavía debe montar el volumen en el nodo seleccionado. Las causas frecuentes son:

- Kubelet no está activo o tiene errores en el worker.
- El directorio del provisionador fue eliminado o no tiene permisos adecuados.
- El nodo donde vive el volumen está en estado `NotReady`.
- El sistema de archivos local está lleno.
- El Pod fue programado en un nodo incompatible con la afinidad del PV local.

**Corrección**

1. Identifique el nodo y el PV involucrados:

   ```bash
   kubectl get pod -n cka-storage -l app=writer -o wide
   kubectl get pvc data-retain -n cka-storage
   kubectl describe pv "${PV_NAME}"
   ```

2. Revise eventos del Pod:

   ```bash
   kubectl describe pod "${WRITER_POD}" -n cka-storage
   ```

3. Conéctese al nodo seleccionado y valide kubelet, espacio y rutas locales:

   ```bash
   ssh <usuario>@${WRITER_NODE}
   sudo systemctl status kubelet --no-pager
   sudo journalctl -u kubelet --since "30 minutes ago" --no-pager | tail -n 100
   df -h
   sudo find /opt/local-path-provisioner -maxdepth 4 -type d 2>/dev/null
   ```

4. Si kubelet está detenido, inícielo y habilítelo:

   ```bash
   sudo systemctl enable --now kubelet
   ```

5. Después de corregir la causa, observe la transición del Pod:

   ```bash
   kubectl get pod -n cka-storage -l app=writer -w
   ```

## Limpieza

La línea base principal debe conservarse para la práctica siguiente:

- Namespace `cka-storage`.
- StorageClass `lab-local-retain`.
- PVC `data-retain` en estado `Bound`.
- PV asociado.
- Deployment `writer` saludable.
- Archivo `/data/lab-state.txt` persistente.

Elimine solamente los recursos de falla controlada:

```bash
kubectl delete pod consumer-rwx-local \
  -n cka-storage \
  --ignore-not-found

kubectl delete pod consumer-claim-inexistente \
  -n cka-storage \
  --ignore-not-found

kubectl delete pvc pvc-sc-inexistente \
  -n cka-storage \
  --ignore-not-found

kubectl delete pvc pvc-rwx-local \
  -n cka-storage \
  --ignore-not-found
```

Elimine los archivos locales de manifiestos de prueba si ya no son necesarios:

```bash
rm -f \
  pvc-storageclass-inexistente.yaml \
  pvc-rwx-local.yaml \
  pod-rwx-local.yaml \
  pod-claim-inexistente.yaml
```

Verifique que la línea base se conserva:

```bash
kubectl get sc lab-local-retain
kubectl get deployment,pod,pvc -n cka-storage -o wide
kubectl get pv -o wide
```

> No ejecute `kubectl delete pvc data-retain -n cka-storage`. Debido a la política `Retain`, el PV y los datos permanecerían, pero el recurso entraría en un ciclo administrativo de recuperación y limpieza que no forma parte de esta práctica.

## Resumen

En esta práctica se creó la StorageClass `lab-local-retain` con el aprovisionador `rancher.io/local-path`, `reclaimPolicy: Retain` y `volumeBindingMode: WaitForFirstConsumer`. Se comprobó que un PVC puede permanecer temporalmente en `Pending` de forma esperada hasta que exista un Pod consumidor, y que el aprovisionamiento dinámico crea un PV asociado al nodo seleccionado.

También se validó el montaje del volumen desde el Pod `writer`, la escritura del archivo `/data/lab-state.txt` y la persistencia de datos después de recrear el Deployment. Finalmente, se analizaron fallas de selección de StorageClass, compatibilidad de acceso para almacenamiento local y referencias a claims inexistentes, utilizando eventos, descripciones de recursos, logs del provisionador y logs de kubelet.

### Recursos opcionales

- [Documentación de Kubernetes: StorageClass](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- [Documentación de Kubernetes: Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [Rancher Local Path Provisioner](https://github.com/rancher/local-path-provisioner)
- [Documentación de Kubernetes: Depuración de Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
