# 4 Práctica 5: Backup y restore de etcd

## Metadatos

| Atributo | Valor |
|---|---|
| Duración | 60 minutos |
| Complejidad | Difícil |
| Nivel de Bloom | Aplicar |

## Descripción general

En esta práctica realizarás un respaldo consistente de etcd y ejecutarás una restauración controlada de un snapshot en un clúster Kubernetes creado con kubeadm. El ejercicio demuestra que etcd conserva el estado persistente del control plane, incluidos objetos como ConfigMaps, ServiceAccounts, bindings RBAC y definiciones de workloads.

La restauración provocará una interrupción temporal del API Server. Por ello, se ejecuta exclusivamente en el entorno de laboratorio, con una ventana de mantenimiento explícita, respaldos previos de manifiestos y certificados, y una validación integral posterior.

## Objetivos de aprendizaje

Al finalizar la práctica, podrás:

- [ ] Identificar el endpoint local de etcd, sus certificados TLS y el directorio de datos usado por kubeadm.
- [ ] Crear y validar snapshots consistentes de etcd mediante `etcdctl 3.5.15`.
- [ ] Diferenciar un respaldo de datos de etcd de un respaldo de manifiestos, certificados y configuración del control plane.
- [ ] Restaurar un snapshot de etcd hacia un directorio de datos nuevo y actualizar el manifiesto del Pod estático.
- [ ] Validar la recuperación del API Server, nodos, RBAC y workloads después de una restauración.

## Prerrequisitos

### Conocimientos requeridos

- Comprensión del rol de etcd como fuente de verdad del estado de Kubernetes.
- Conocimiento básico de Pods estáticos y del directorio `/etc/kubernetes/manifests`.
- Familiaridad con `kubectl`, `etcdctl`, manifiestos YAML y certificados TLS.
- Comprensión de que un restore de etcd devuelve el control plane a un punto anterior en el tiempo.

### Acceso requerido

- Acceso SSH o consola a `cp1` con privilegios `sudo`.
- Credenciales `cluster-admin` funcionales en `cp1`.
- Clúster de cuatro nodos operativo: `cp1`, `worker1`, `worker2` y `worker3`.
- Objetos de prácticas anteriores disponibles:
  - Namespace `operations`.
  - ServiceAccount `ops-maintainer`.
  - Objetos RBAC asociados a `node-readonly`.
- Al menos 2 GB libres bajo `/root`.
- `etcdctl 3.5.15` disponible en `cp1`.

> **Advertencia:** no ejecutes este procedimiento en un clúster de producción sin un plan formal de recuperación ante desastres, aprobación de ventana de mantenimiento, validación de compatibilidad y respaldo externo verificado.

## Entorno del laboratorio

### Topología

| Nodo | Dirección IP | Función |
|---|---:|---|
| `cp1` | `10.10.10.10` | Control plane y miembro único de etcd |
| `worker1` | `10.10.10.11` | Nodo worker |
| `worker2` | `10.10.10.12` | Nodo worker |
| `worker3` | `10.10.10.13` | Nodo worker |

### Componentes principales

| Componente | Versión o configuración esperada |
|---|---|
| Kubernetes | `1.31.6-1.1` |
| etcdctl | `3.5.15` |
| Runtime | containerd `1.7.24-1` |
| Endpoint etcd | `https://127.0.0.1:2379` |
| Directorio de datos original | `/var/lib/etcd` |
| Directorio de restauración | `/var/lib/etcd-restore` |
| Directorio de manifiestos | `/etc/kubernetes/manifests` |
| API Server | `https://10.10.10.10:6443` |

### Preparación de sesión

1. Conéctate a `cp1`.

   ```bash
   ssh <usuario>@10.10.10.10
   ```

2. Abre una shell administrativa y configura `kubectl`.

   ```bash
   sudo -i
   export KUBECONFIG=/etc/kubernetes/admin.conf
   ```

3. Define variables reutilizables para el laboratorio.

   ```bash
   export ETCDCTL_API=3

   export ETCD_ENDPOINT="https://127.0.0.1:2379"
   export ETCD_CA="/etc/kubernetes/pki/etcd/ca.crt"
   export ETCD_CERT="/etc/kubernetes/pki/etcd/server.crt"
   export ETCD_KEY="/etc/kubernetes/pki/etcd/server.key"

   export LAB_DIR="/root/labs/etcd"
   export SNAPSHOT_DIR="${LAB_DIR}/snapshots"
   export CP_BACKUP_DIR="${LAB_DIR}/control-plane-backup"
   export MANIFEST_HOLD="${LAB_DIR}/manifests-hold"

   mkdir -p "${SNAPSHOT_DIR}" "${CP_BACKUP_DIR}" "${MANIFEST_HOLD}"
   chmod 700 "${LAB_DIR}" "${SNAPSHOT_DIR}" "${CP_BACKUP_DIR}" "${MANIFEST_HOLD}"
   ```

4. Comprueba versiones y espacio disponible.

   ```bash
   kubectl version --client
   etcdctl version
   df -h /root /var/lib
   ```

**Salida esperada**

- `kubectl` informa versión cliente `v1.31.6`.
- `etcdctl` informa versión `3.5.15`.
- Hay al menos 2 GB disponibles en `/root`.

**Verificación**

```bash
test "$(etcdctl version | awk '/etcdctl version/{print $3}')" = "3.5.15" && echo "etcdctl correcto"
```

---

## Procedimiento paso a paso

### Paso 1. Inspeccionar la configuración activa de etcd

**Objetivo:** identificar el endpoint, certificados, nombre del miembro, parámetros de peer y directorio de datos antes de crear cualquier respaldo.

**Instrucciones**

1. Comprueba que los nodos y el control plane están disponibles.

   ```bash
   kubectl get nodes -o wide
   kubectl get pods -n kube-system -o wide
   ```

2. Localiza el Pod estático de etcd.

   ```bash
   kubectl get pods -n kube-system | grep '^etcd-'
   ```

3. Inspecciona los parámetros importantes del manifiesto de etcd.

   ```bash
   grep -E -- \
     '--name=|--data-dir=|--listen-client-urls=|--advertise-client-urls=|--initial-advertise-peer-urls=|--initial-cluster=|--cert-file=|--key-file=|--trusted-ca-file=' \
     /etc/kubernetes/manifests/etcd.yaml
   ```

4. Revisa los parámetros con los que el API Server se comunica con etcd.

   ```bash
   grep -E -- \
     '--etcd-servers|--etcd-cafile|--etcd-certfile|--etcd-keyfile' \
     /etc/kubernetes/manifests/kube-apiserver.yaml
   ```

5. Comprueba la salud y el estado del endpoint local de etcd.

   ```bash
   etcdctl \
     --endpoints="${ETCD_ENDPOINT}" \
     --cacert="${ETCD_CA}" \
     --cert="${ETCD_CERT}" \
     --key="${ETCD_KEY}" \
     endpoint health

   etcdctl \
     --endpoints="${ETCD_ENDPOINT}" \
     --cacert="${ETCD_CA}" \
     --cert="${ETCD_CERT}" \
     --key="${ETCD_KEY}" \
     endpoint status --write-out=table
   ```

6. Guarda evidencia no sensible de la configuración detectada.

   ```bash
   {
     date -Is
     hostnamectl --static
     grep -E -- \
       '--name=|--data-dir=|--initial-advertise-peer-urls=|--initial-cluster=' \
       /etc/kubernetes/manifests/etcd.yaml
   } > "${LAB_DIR}/evidencia-configuracion-etcd.txt"
   ```

**Salida esperada**

- El manifiesto contiene `--data-dir=/var/lib/etcd`.
- El endpoint local responde como saludable.
- El miembro suele llamarse `cp1`.
- El `initial-cluster` contiene un valor similar a:

  ```text
  cp1=https://10.10.10.10:2380
  ```

**Verificación**

```bash
etcdctl \
  --endpoints="${ETCD_ENDPOINT}" \
  --cacert="${ETCD_CA}" \
  --cert="${ETCD_CERT}" \
  --key="${ETCD_KEY}" \
  endpoint health
```

Debe incluir un mensaje equivalente a:

```text
https://127.0.0.1:2379 is healthy
```

---

### Paso 2. Crear el snapshot inicial y respaldar los artefactos del control plane

**Objetivo:** crear el snapshot obligatorio `pre-restore-001.db` y conservar una copia independiente de manifiestos y PKI.

**Instrucciones**

1. Crea el snapshot inicial usando el endpoint local y los certificados indicados.

   ```bash
   etcdctl \
     --endpoints=https://127.0.0.1:2379 \
     --cacert=/etc/kubernetes/pki/etcd/ca.crt \
     --cert=/etc/kubernetes/pki/etcd/server.crt \
     --key=/etc/kubernetes/pki/etcd/server.key \
     snapshot save "${SNAPSHOT_DIR}/pre-restore-001.db"
   ```

2. Valida la integridad y los metadatos del snapshot sin restaurarlo.

   ```bash
   etcdctl snapshot status \
     "${SNAPSHOT_DIR}/pre-restore-001.db" \
     --write-out=table
   ```

3. Protege el archivo de snapshot con permisos restrictivos.

   ```bash
   chmod 600 "${SNAPSHOT_DIR}/pre-restore-001.db"
   ```

4. Copia los manifiestos estáticos y la PKI de Kubernetes. Estos respaldos no sustituyen al snapshot de etcd, pero son fundamentales para recuperar la configuración del control plane y sus certificados.

   ```bash
   cp -a /etc/kubernetes/manifests "${CP_BACKUP_DIR}/"
   cp -a /etc/kubernetes/pki "${CP_BACKUP_DIR}/"
   ```

5. Genera una suma de verificación de los respaldos principales.

   ```bash
   sha256sum "${SNAPSHOT_DIR}/pre-restore-001.db" \
     > "${SNAPSHOT_DIR}/pre-restore-001.db.sha256"

   find "${CP_BACKUP_DIR}" -type f -print0 | sort -z | xargs -0 sha256sum \
     > "${CP_BACKUP_DIR}/SHA256SUMS"
   ```

6. Registra el contenido de los directorios de respaldo.

   ```bash
   ls -lah "${SNAPSHOT_DIR}"
   ls -lah "${CP_BACKUP_DIR}"
   ```

**Salida esperada**

- `snapshot save` informa que el snapshot fue guardado correctamente.
- `snapshot status` muestra columnas como `HASH`, `REVISION`, `TOTAL KEYS` y `TOTAL SIZE`.
- Existen los directorios:

  ```text
  /root/labs/etcd/control-plane-backup/manifests
  /root/labs/etcd/control-plane-backup/pki
  ```

**Verificación**

```bash
test -s "${SNAPSHOT_DIR}/pre-restore-001.db" \
  && test -d "${CP_BACKUP_DIR}/manifests" \
  && test -d "${CP_BACKUP_DIR}/pki" \
  && echo "Respaldo inicial y artefactos del control plane disponibles"
```

> **Nota operativa:** el snapshot guarda datos de etcd, incluidos objetos de Kubernetes. La copia de `manifests` y `pki` guarda configuración y material criptográfico del control plane. Ambos tipos de respaldo son complementarios.

---

### Paso 3. Crear el objeto marcador y el punto de restauración

**Objetivo:** crear un ConfigMap que permita demostrar de forma objetiva que el restore devuelve el estado de etcd al punto del snapshot.

**Instrucciones**

1. Confirma la existencia de los recursos de prácticas anteriores.

   ```bash
   kubectl get namespace operations
   kubectl -n operations get serviceaccount ops-maintainer
   kubectl get clusterrole node-readonly
   kubectl get clusterrolebinding | grep node-readonly || true
   ```

2. Captura evidencia previa de RBAC y workloads en archivos locales.

   ```bash
   kubectl -n operations get serviceaccount ops-maintainer -o yaml \
     > "${LAB_DIR}/ops-maintainer-pre-restore.yaml"

   kubectl get clusterrole node-readonly -o yaml \
     > "${LAB_DIR}/node-readonly-pre-restore.yaml"

   kubectl get clusterrolebinding -o yaml \
     > "${LAB_DIR}/clusterrolebindings-pre-restore.yaml"

   kubectl -n operations get deploy,statefulset,daemonset,pods,svc,pvc -o wide \
     > "${LAB_DIR}/operations-pre-restore.txt"
   ```

3. Crea el ConfigMap marcador `restore-validation`.

   ```bash
   kubectl -n operations create configmap restore-validation \
     --from-literal=purpose="validate-etcd-restore" \
     --from-literal=snapshot="restore-point-002.db" \
     --from-literal=created-at="$(date -Is)"
   ```

4. Consulta el ConfigMap para confirmar que fue persistido mediante la API de Kubernetes.

   ```bash
   kubectl -n operations get configmap restore-validation -o yaml
   ```

5. Crea el segundo snapshot, que será el punto que posteriormente restaurarás.

   ```bash
   etcdctl \
     --endpoints=https://127.0.0.1:2379 \
     --cacert=/etc/kubernetes/pki/etcd/ca.crt \
     --cert=/etc/kubernetes/pki/etcd/server.crt \
     --key=/etc/kubernetes/pki/etcd/server.key \
     snapshot save "${SNAPSHOT_DIR}/restore-point-002.db"
   ```

6. Valida el segundo snapshot y calcula su suma de verificación.

   ```bash
   etcdctl snapshot status \
     "${SNAPSHOT_DIR}/restore-point-002.db" \
     --write-out=table

   chmod 600 "${SNAPSHOT_DIR}/restore-point-002.db"

   sha256sum "${SNAPSHOT_DIR}/restore-point-002.db" \
     > "${SNAPSHOT_DIR}/restore-point-002.db.sha256"
   ```

7. Elimina deliberadamente el ConfigMap marcador.

   ```bash
   kubectl -n operations delete configmap restore-validation
   ```

8. Confirma su ausencia antes de iniciar la recuperación.

   ```bash
   kubectl -n operations get configmap restore-validation
   ```

**Salida esperada**

- La creación del ConfigMap informa `configmap/restore-validation created`.
- El segundo snapshot presenta metadatos válidos.
- Tras la eliminación, la última consulta devuelve `NotFound`.

**Verificación**

```bash
if kubectl -n operations get configmap restore-validation >/dev/null 2>&1; then
  echo "ERROR: el ConfigMap aún existe; no continúe."
else
  echo "Correcto: el ConfigMap está ausente y el restore podrá demostrar su recuperación."
fi
```

---

### Paso 4. Preparar la ventana de mantenimiento y detener los Pods estáticos

**Objetivo:** detener temporalmente los componentes del control plane para restaurar el snapshot sin que etcd activo utilice el directorio de datos restaurado.

**Instrucciones**

1. Registra la hora de inicio de la ventana de mantenimiento.

   ```bash
   date -Is | tee "${LAB_DIR}/inicio-ventana-mantenimiento.txt"
   ```

2. Verifica que el directorio de restauración no existe o está vacío.

   ```bash
   ls -ld /var/lib/etcd-restore 2>/dev/null || true
   ```

3. Si existe un directorio de una prueba anterior, no lo reutilices. Muévelo a una ubicación fechada para preservar evidencia.

   ```bash
   if [ -e /var/lib/etcd-restore ]; then
     mv /var/lib/etcd-restore "/var/lib/etcd-restore.previous.$(date +%Y%m%d%H%M%S)"
   fi
   ```

4. Confirma los manifiestos que serán retirados temporalmente.

   ```bash
   ls -lah /etc/kubernetes/manifests/
   ```

5. Mueve todos los manifiestos estáticos del control plane a un directorio de retención.

   ```bash
   mv /etc/kubernetes/manifests/*.yaml "${MANIFEST_HOLD}/"
   ```

6. Espera a que el kubelet detecte la ausencia de manifiestos y detenga los contenedores estáticos.

   ```bash
   sleep 30

   crictl --runtime-endpoint unix:///run/containerd/containerd.sock ps -a \
     | grep -E 'etcd|kube-apiserver|kube-controller-manager|kube-scheduler' || true
   ```

7. Confirma que el API Server ya no está disponible. Esta indisponibilidad es esperada durante la recuperación.

   ```bash
   kubectl get --raw=/readyz
   ```

**Salida esperada**

- Los cuatro manifiestos se encuentran bajo `/root/labs/etcd/manifests-hold`.
- El API Server deja de responder.
- Los Pods estáticos aparecen detenidos o ya no aparecen en `crictl`.

**Verificación**

```bash
ls -1 "${MANIFEST_HOLD}/"
```

Debe mostrar al menos:

```text
etcd.yaml
kube-apiserver.yaml
kube-controller-manager.yaml
kube-scheduler.yaml
```

> **Importante:** no borres `/var/lib/etcd` durante esta práctica. Se conserva como referencia y posible vía de rollback manual. La restauración se realizará en `/var/lib/etcd-restore`.

---

### Paso 5. Restaurar el snapshot hacia un directorio nuevo

**Objetivo:** reconstruir los datos de etcd desde `restore-point-002.db` en un directorio independiente.

**Instrucciones**

1. Extrae los valores de miembro y peer URL desde el manifiesto retenido.

   ```bash
   grep -E -- '--name=|--initial-advertise-peer-urls=|--initial-cluster=' \
     "${MANIFEST_HOLD}/etcd.yaml"
   ```

2. Ejecuta la restauración. Para esta topología de etcd de un solo miembro, se usan los valores esperados de `cp1`.

   ```bash
   etcdctl snapshot restore \
     "${SNAPSHOT_DIR}/restore-point-002.db" \
     --data-dir=/var/lib/etcd-restore \
     --name=cp1 \
     --initial-cluster=cp1=https://10.10.10.10:2380 \
     --initial-advertise-peer-urls=https://10.10.10.10:2380
   ```

3. Comprueba que el directorio restaurado contiene datos de etcd.

   ```bash
   find /var/lib/etcd-restore -maxdepth 3 -type f -o -type d | head -30
   ```

4. Ajusta permisos para que coincidan con el usuario que ejecuta etcd. En una instalación kubeadm estándar, etcd se ejecuta como `root`.

   ```bash
   chown -R root:root /var/lib/etcd-restore
   chmod 700 /var/lib/etcd-restore
   ```

5. Realiza una validación final de la estructura restaurada.

   ```bash
   test -d /var/lib/etcd-restore/member/snap \
     && test -d /var/lib/etcd-restore/member/wal \
     && echo "Directorio restaurado preparado"
   ```

**Salida esperada**

- `etcdctl snapshot restore` finaliza sin errores.
- Existe `/var/lib/etcd-restore/member`.
- El directorio contiene subdirectorios como `snap` y `wal`.

**Verificación**

```bash
du -sh /var/lib/etcd-restore
```

El directorio debe tener un tamaño mayor que cero.

---

### Paso 6. Actualizar el manifiesto de etcd y reactivar el control plane

**Objetivo:** configurar el Pod estático de etcd para utilizar los datos restaurados y recuperar progresivamente el control plane.

**Instrucciones**

1. Crea una copia de seguridad local adicional del manifiesto retenido antes de editarlo.

   ```bash
   cp -a "${MANIFEST_HOLD}/etcd.yaml" \
     "${LAB_DIR}/etcd.yaml.pre-restore-data-dir"
   ```

2. Sustituye únicamente el directorio de datos en el manifiesto de etcd retenido.

   ```bash
   sed -i \
     's#--data-dir=/var/lib/etcd#--data-dir=/var/lib/etcd-restore#' \
     "${MANIFEST_HOLD}/etcd.yaml"
   ```

3. Comprueba que el manifiesto apunta al directorio restaurado y no al original.

   ```bash
   grep -- '--data-dir=' "${MANIFEST_HOLD}/etcd.yaml"
   ```

4. Reactiva primero el manifiesto de etcd.

   ```bash
   cp -a "${MANIFEST_HOLD}/etcd.yaml" /etc/kubernetes/manifests/etcd.yaml
   ```

5. Espera a que kubelet inicie etcd y valida el endpoint directamente con `etcdctl`.

   ```bash
   sleep 25

   etcdctl \
     --endpoints="${ETCD_ENDPOINT}" \
     --cacert="${ETCD_CA}" \
     --cert="${ETCD_CERT}" \
     --key="${ETCD_KEY}" \
     endpoint health
   ```

6. Cuando etcd esté saludable, reactiva los demás manifiestos del control plane.

   ```bash
   cp -a "${MANIFEST_HOLD}/kube-apiserver.yaml" \
     /etc/kubernetes/manifests/kube-apiserver.yaml

   cp -a "${MANIFEST_HOLD}/kube-controller-manager.yaml" \
     /etc/kubernetes/manifests/kube-controller-manager.yaml

   cp -a "${MANIFEST_HOLD}/kube-scheduler.yaml" \
     /etc/kubernetes/manifests/kube-scheduler.yaml
   ```

7. Espera la recuperación del API Server. El siguiente bucle intenta durante un máximo aproximado de cinco minutos.

   ```bash
   for i in $(seq 1 60); do
     if kubectl get --raw=/readyz >/dev/null 2>&1; then
       echo "API Server disponible en el intento ${i}"
       break
     fi
     echo "Esperando disponibilidad del API Server (${i}/60)..."
     sleep 5
   done
   ```

8. Verifica la disponibilidad del API Server y los Pods estáticos.

   ```bash
   kubectl get --raw=/readyz
   kubectl get pods -n kube-system -o wide
   ```

**Salida esperada**

- `etcdctl endpoint health` vuelve a indicar que etcd está saludable.
- El endpoint `/readyz` del API Server responde `ok`.
- Los Pods `etcd-cp1`, `kube-apiserver-cp1`, `kube-controller-manager-cp1` y `kube-scheduler-cp1` vuelven a ejecutarse.

**Verificación**

```bash
kubectl get --raw=/readyz && \
kubectl get pods -n kube-system | grep -E 'etcd-cp1|kube-apiserver-cp1'
```

> **Punto de control:** el API Server restaurado consulta la base de datos reconstruida en `/var/lib/etcd-restore`. El directorio original `/var/lib/etcd` permanece intacto y no debe modificarse durante esta validación.

---

### Paso 7. Validar el estado recuperado del clúster

**Objetivo:** confirmar que el snapshot devolvió al clúster el ConfigMap marcador, los nodos, los objetos RBAC y los workloads esperados.

**Instrucciones**

1. Confirma que el ConfigMap `restore-validation` reapareció.

   ```bash
   kubectl -n operations get configmap restore-validation -o yaml
   ```

2. Verifica específicamente los valores que fueron almacenados antes del snapshot.

   ```bash
   kubectl -n operations get configmap restore-validation \
     -o jsonpath='{.data.purpose}{"\n"}{.data.snapshot}{"\n"}'
   ```

3. Comprueba que los cuatro nodos recuperan el estado `Ready`. Es normal que los workers tarden brevemente en renovar leases y condiciones después de la indisponibilidad del API Server.

   ```bash
   kubectl get nodes -o wide
   ```

4. Espera explícitamente a que todos los nodos estén disponibles.

   ```bash
   kubectl wait --for=condition=Ready node/cp1 --timeout=180s
   kubectl wait --for=condition=Ready node/worker1 --timeout=180s
   kubectl wait --for=condition=Ready node/worker2 --timeout=180s
   kubectl wait --for=condition=Ready node/worker3 --timeout=180s
   ```

5. Valida la persistencia del ServiceAccount y de los objetos RBAC.

   ```bash
   kubectl -n operations get serviceaccount ops-maintainer -o yaml

   kubectl get clusterrole node-readonly -o yaml

   kubectl get clusterrolebinding -o custom-columns=NAME:.metadata.name,ROLE:.roleRef.name \
     | grep node-readonly || true
   ```

6. Comprueba los workloads del namespace `operations`.

   ```bash
   kubectl -n operations get deploy,statefulset,daemonset,pods,svc,pvc -o wide
   ```

7. Revisa los eventos recientes del namespace `operations` y de `kube-system`.

   ```bash
   kubectl -n operations get events \
     --sort-by=.lastTimestamp | tail -30

   kubectl -n kube-system get events \
     --sort-by=.lastTimestamp | tail -30
   ```

8. Guarda evidencia posterior a la restauración.

   ```bash
   kubectl get nodes -o wide \
     > "${LAB_DIR}/nodos-post-restore.txt"

   kubectl -n operations get deploy,statefulset,daemonset,pods,svc,pvc -o wide \
     > "${LAB_DIR}/operations-post-restore.txt"

   kubectl -n operations get configmap restore-validation -o yaml \
     > "${LAB_DIR}/restore-validation-post-restore.yaml"

   date -Is | tee "${LAB_DIR}/fin-ventana-mantenimiento.txt"
   ```

**Salida esperada**

- El ConfigMap `restore-validation` existe nuevamente.
- Sus datos incluyen `validate-etcd-restore` y `restore-point-002.db`.
- `cp1`, `worker1`, `worker2` y `worker3` muestran estado `Ready`.
- El ServiceAccount `ops-maintainer` y los objetos `node-readonly` están presentes.
- Los workloads de `operations` alcanzan su estado esperado según sus réplicas y controladores.

**Verificación**

```bash
kubectl -n operations get configmap restore-validation >/dev/null && \
kubectl -n operations get serviceaccount ops-maintainer >/dev/null && \
kubectl get clusterrole node-readonly >/dev/null && \
kubectl get nodes --no-headers | awk '$2 != "Ready" {exit 1}' && \
echo "Validación post-restore satisfactoria"
```

## Validación y pruebas

Ejecuta esta secuencia final para consolidar la evidencia técnica de la recuperación.

1. Verifica la salud de etcd.

   ```bash
   etcdctl \
     --endpoints="${ETCD_ENDPOINT}" \
     --cacert="${ETCD_CA}" \
     --cert="${ETCD_CERT}" \
     --key="${ETCD_KEY}" \
     endpoint health
   ```

2. Verifica disponibilidad del API Server.

   ```bash
   kubectl get --raw=/livez
   kubectl get --raw=/readyz
   ```

3. Verifica la recuperación de los nodos.

   ```bash
   kubectl get nodes
   ```

4. Verifica que el objeto eliminado después del snapshot fue recuperado.

   ```bash
   kubectl -n operations get configmap restore-validation
   ```

5. Verifica recursos RBAC relevantes.

   ```bash
   kubectl -n operations get sa ops-maintainer
   kubectl get clusterrole node-readonly
   kubectl get clusterrolebinding -o wide | grep node-readonly || true
   ```

6. Verifica que los Pods de `operations` convergieron a su estado deseado.

   ```bash
   kubectl -n operations get pods
   kubectl -n operations get deploy,statefulset,daemonset
   ```

7. Verifica que los snapshots y las copias de control plane permanecen disponibles.

   ```bash
   etcdctl snapshot status "${SNAPSHOT_DIR}/pre-restore-001.db" --write-out=table
   etcdctl snapshot status "${SNAPSHOT_DIR}/restore-point-002.db" --write-out=table

   sha256sum -c "${SNAPSHOT_DIR}/pre-restore-001.db.sha256"
   sha256sum -c "${SNAPSHOT_DIR}/restore-point-002.db.sha256"

   ls -lah "${CP_BACKUP_DIR}/manifests"
   ls -lah "${CP_BACKUP_DIR}/pki"
   ```

Criterios de éxito de la práctica:

| Validación | Resultado esperado |
|---|---|
| Snapshot inicial | `pre-restore-001.db` existe, tiene tamaño mayor que cero y estado válido |
| Punto de restore | `restore-point-002.db` existe y tiene estado válido |
| Restore | etcd utiliza `/var/lib/etcd-restore` |
| API Server | `/readyz` responde correctamente |
| ConfigMap marcador | `restore-validation` reaparece |
| Nodos | Los cuatro nodos están `Ready` |
| RBAC | `ops-maintainer` y `node-readonly` siguen disponibles |
| Workloads | Los recursos de `operations` alcanzan el estado esperado |

## Resolución de problemas

### Problema 1: `etcdctl` no puede conectarse a `https://127.0.0.1:2379`

**Síntomas**

```text
connection refused
```

o:

```text
x509: certificate signed by unknown authority
```

o:

```text
authentication failed
```

**Causa**

El Pod estático de etcd no está ejecutándose, se utilizaron rutas TLS incorrectas, el certificado no coincide con la CA configurada o el manifiesto restaurado contiene un error de sintaxis o un directorio de datos inaccesible.

**Corrección**

1. Revisa el estado del contenedor y los logs de kubelet.

   ```bash
   crictl --runtime-endpoint unix:///run/containerd/containerd.sock ps -a | grep etcd || true
   journalctl -u kubelet -n 100 --no-pager
   ```

2. Verifica que el manifiesto activo apunta al directorio correcto.

   ```bash
   grep -- '--data-dir=' /etc/kubernetes/manifests/etcd.yaml
   ```

3. Comprueba que existen los archivos de certificados y los datos restaurados.

   ```bash
   ls -l /etc/kubernetes/pki/etcd/ca.crt
   ls -l /etc/kubernetes/pki/etcd/server.crt
   ls -l /etc/kubernetes/pki/etcd/server.key
   ls -ld /var/lib/etcd-restore/member
   ```

4. Si el manifiesto se editó incorrectamente, compara con la copia previa y corrige exclusivamente `--data-dir`.

   ```bash
   diff -u \
     "${LAB_DIR}/etcd.yaml.pre-restore-data-dir" \
     /etc/kubernetes/manifests/etcd.yaml
   ```

---

### Problema 2: el API Server no vuelve a estar disponible o los nodos permanecen `NotReady`

**Síntomas**

- `kubectl get --raw=/readyz` devuelve errores de conexión.
- El Pod `kube-apiserver-cp1` no aparece o reinicia continuamente.
- Los workers muestran `NotReady` durante más de varios minutos después de recuperar el API Server.

**Causa**

Los manifiestos del control plane no fueron restaurados completamente, `kube-apiserver` se inició antes de que etcd estuviera saludable, o los kubelets de los nodos aún no han renovado su estado y lease contra el API Server recuperado.

**Corrección**

1. Confirma que los cuatro manifiestos están nuevamente en el directorio activo.

   ```bash
   ls -lah /etc/kubernetes/manifests/
   ```

2. Consulta los contenedores del control plane y los logs del kubelet.

   ```bash
   crictl --runtime-endpoint unix:///run/containerd/containerd.sock ps -a \
     | grep -E 'kube-apiserver|kube-controller-manager|kube-scheduler|etcd' || true

   journalctl -u kubelet -n 150 --no-pager
   ```

3. Confirma primero la salud de etcd y luego espera el reinicio del API Server.

   ```bash
   etcdctl \
     --endpoints="${ETCD_ENDPOINT}" \
     --cacert="${ETCD_CA}" \
     --cert="${ETCD_CERT}" \
     --key="${ETCD_KEY}" \
     endpoint health
   ```

4. Cuando el API Server responda, revisa el estado de los nodos y espera la reconciliación.

   ```bash
   kubectl get nodes -o wide
   kubectl get events -A --sort-by=.lastTimestamp | tail -50
   ```

5. Si un worker continúa `NotReady`, conéctate al nodo afectado y revisa el kubelet y el runtime.

   ```bash
   sudo systemctl status kubelet --no-pager
   sudo journalctl -u kubelet -n 100 --no-pager
   sudo systemctl status containerd --no-pager
   ```

## Limpieza

La práctica produce artefactos que deben conservarse como evidencia y como base de recuperación. No elimines snapshots, copias PKI ni el directorio original `/var/lib/etcd` al finalizar.

1. Confirma que ya no quedan manifiestos retenidos fuera del directorio activo.

   ```bash
   ls -lah "${MANIFEST_HOLD}"
   ```

2. Si todos los manifiestos fueron restaurados correctamente, conserva el directorio de retención vacío como evidencia o elimínalo.

   ```bash
   rmdir "${MANIFEST_HOLD}" 2>/dev/null || true
   ```

3. Conserva los siguientes artefactos protegidos:

   ```bash
   find "${LAB_DIR}" -maxdepth 3 -type f -printf '%p\n' | sort
   ```

4. Mantén permisos restrictivos sobre snapshots, PKI y evidencia.

   ```bash
   chmod 700 "${LAB_DIR}" "${SNAPSHOT_DIR}" "${CP_BACKUP_DIR}"
   chmod 600 "${SNAPSHOT_DIR}"/*.db "${SNAPSHOT_DIR}"/*.sha256
   ```

5. Documenta en tu bitácora operativa:
   - Fecha y hora de la ventana de mantenimiento.
   - Hash SHA-256 de ambos snapshots.
   - Directorio restaurado utilizado: `/var/lib/etcd-restore`.
   - Estado final de los cuatro nodos.
   - Resultado de la validación del ConfigMap, RBAC y workloads.

## Resumen

En esta práctica creaste un snapshot consistente de etcd usando autenticación TLS, validaste su contenido y protegiste además los manifiestos y certificados del control plane. Después creaste un objeto marcador, generaste un punto de restauración, eliminaste deliberadamente el objeto y restauraste el snapshot en un directorio de datos nuevo.

La recuperación demostró que etcd contiene el estado persistente del clúster: el ConfigMap `restore-validation`, el ServiceAccount `ops-maintainer`, los objetos RBAC relacionados con `node-readonly` y las definiciones de workloads reaparecen conforme al punto temporal del snapshot. Un restore de etcd no es una operación rutinaria: requiere ventana de mantenimiento, respaldos previos, control de cambios y validación integral del control plane y de las cargas administradas.

### Recursos opcionales

- [Kubernetes: Operación de etcd](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- [Kubernetes: Recuperación ante desastres con etcd](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/#restoring-an-etcd-cluster)
- [etcd: Guía de operaciones](https://etcd.io/docs/v3.5/op-guide/)
- [Kubernetes: Pods estáticos](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
