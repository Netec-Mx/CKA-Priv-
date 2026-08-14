# 5 Práctica 1: Inspección completa de un clúster Kubernetes

## Metadatos

| Campo | Valor |
|---|---|
| Duración | 50 minutos |
| Complejidad | Media |
| Nivel de Bloom | Aplicar |

## Descripción general

En esta práctica adoptarás la perspectiva de un administrador de clúster Kubernetes: antes de investigar una aplicación, validarás la salud de la infraestructura que la soporta. Inspeccionarás la topología, las versiones, los nodos, los componentes del plano de control, los servicios del sistema, el runtime `containerd`, la red Calico y los recursos críticos del namespace `kube-system`.

El resultado será un informe de línea base reproducible del clúster compuesto por `cp1`, `worker1` y `worker2`. Este informe se conservará como referencia para comparar el estado del clúster antes y después de futuras operaciones de mantenimiento.

## Objetivos de aprendizaje

Al finalizar la práctica, podrás:

- [ ] Confirmar el contexto administrativo, la versión del cliente y la versión del servidor Kubernetes.
- [ ] Identificar nodos, roles, condiciones, capacidad y recursos asignables del clúster.
- [ ] Relacionar los Pods estáticos del plano de control con sus manifiestos en `/etc/kubernetes/manifests`.
- [ ] Inspeccionar `kubelet`, `containerd`, `kube-proxy`, CRI y la red Calico desde los nodos.
- [ ] Crear un informe técnico de línea base con evidencia obtenida mediante `kubectl`, `systemctl`, `journalctl`, `crictl`, rutas e interfaces de red.

## Prerrequisitos

### Conocimientos requeridos

- Uso básico de `kubectl get`, `kubectl describe`, `kubectl logs` y salida YAML.
- Comprensión básica de Pods, namespaces, nodos y DaemonSets.
- Familiaridad con SSH, `sudo`, `systemctl`, `journalctl`, `ip` y comandos de Linux.
- Conocimiento de la diferencia entre la perspectiva CKAD y CKA: esta práctica prioriza la infraestructura del clúster sobre las aplicaciones.

### Acceso requerido

- Acceso SSH con privilegios `sudo` a:
  - `cp1` — `10.10.10.10`
  - `worker1` — `10.10.10.11`
  - `worker2` — `10.10.10.12`
- Archivo administrativo funcional `/etc/kubernetes/admin.conf` en `cp1`.
- Clúster Kubernetes inicializado con `kubeadm`.
- Calico `3.29.2` desplegado y configurado para el Pod CIDR `192.168.0.0/16`.
- Acceso de red entre todos los nodos.

> **Importante:** esta práctica es principalmente de inspección. No reinicies servicios, no elimines Pods y no modifiques manifiestos durante la ejecución.

## Entorno de laboratorio

### Topología

| Nodo | Dirección IPv4 | Función | Hostname obligatorio |
|---|---:|---|---|
| `cp1` | `10.10.10.10/24` | Control plane | `cp1` |
| `worker1` | `10.10.10.11/24` | Worker | `worker1` |
| `worker2` | `10.10.10.12/24` | Worker | `worker2` |

### Versiones y parámetros esperados

| Componente o parámetro | Valor esperado |
|---|---|
| Kubernetes (`kubeadm`, `kubelet`, `kubectl`) | `1.31.6-1.1` |
| Container runtime | `containerd 1.7.24-1` |
| Endpoint CRI | `unix:///run/containerd/containerd.sock` |
| Cgroup driver | `SystemdCgroup = true` |
| CNI | Calico `3.29.2` |
| Pod CIDR | `192.168.0.0/16` |
| Service CIDR | `10.96.0.0/12` |
| DNS de Services | `10.96.0.10` |
| Endpoint del API Server | `https://10.10.10.10:6443` |
| Runtime Docker Engine | No debe estar instalado ni usado |

### Preparación de la sesión administrativa

1. Conéctate al nodo de control:

   ```bash
   ssh <usuario>@10.10.10.10
   ```

2. Confirma el hostname:

   ```bash
   hostnamectl --static
   ```

3. Configura temporalmente `kubectl` para usar el kubeconfig administrativo:

   ```bash
   export KUBECONFIG=/etc/kubernetes/admin.conf
   ```

4. Crea un directorio para almacenar evidencia de la práctica:

   ```bash
   export LAB_DIR="$HOME/lab-01-00-01"
   mkdir -p "$LAB_DIR"
   ```

5. Verifica que las resoluciones de nombres de los nodos sean consistentes:

   ```bash
   getent hosts cp1 worker1 worker2
   ```

## Procedimiento paso a paso

### Paso 1. Validar el acceso administrativo y la identidad del clúster

**Objetivo:** confirmar que `kubectl` apunta al clúster correcto y que el plano de control responde mediante el endpoint esperado.

**Instrucciones:**

1. Muestra el contexto activo y su configuración:

   ```bash
   kubectl config current-context
   kubectl config view --minify
   ```

2. Consulta versiones del cliente y del servidor:

   ```bash
   kubectl version
   ```

3. Obtén información general del endpoint del clúster:

   ```bash
   kubectl cluster-info
   ```

4. Comprueba que el API Server responde a una solicitud autenticada:

   ```bash
   kubectl auth can-i get nodes
   kubectl get --raw=/readyz?verbose
   ```

5. Guarda evidencia de la sesión:

   ```bash
   {
     echo "===== Fecha UTC ====="
     date -u
     echo
     echo "===== Contexto activo ====="
     kubectl config current-context
     echo
     echo "===== Versiones ====="
     kubectl version
     echo
     echo "===== Cluster info ====="
     kubectl cluster-info
     echo
     echo "===== API Server readiness ====="
     kubectl get --raw=/readyz?verbose
   } | tee "$LAB_DIR/01-contexto-y-api.txt"
   ```

**Salida esperada:**

- El contexto activo corresponde al clúster de laboratorio.
- `kubectl version` muestra cliente y servidor Kubernetes `v1.31.6`.
- `kubectl cluster-info` indica que Kubernetes control plane está disponible en:

  ```text
  https://10.10.10.10:6443
  ```

- La solicitud `/readyz?verbose` contiene verificaciones con estado `ok`.

**Verificación:**

Ejecuta:

```bash
kubectl get nodes
```

La consulta debe devolver los tres nodos sin errores de autenticación, certificado o conectividad.

---

### Paso 2. Inspeccionar nodos, roles, condiciones y capacidad

**Objetivo:** establecer el estado operativo de `cp1`, `worker1` y `worker2`, identificando roles, condiciones y recursos disponibles.

**Instrucciones:**

1. Muestra los nodos con información ampliada:

   ```bash
   kubectl get nodes -o wide
   ```

2. Muestra etiquetas que permiten identificar roles y topología:

   ```bash
   kubectl get nodes --show-labels
   ```

3. Consulta las condiciones relevantes de todos los nodos:

   ```bash
   kubectl describe nodes | sed -n '/^Name:/,/^Non-terminated Pods:/p'
   ```

4. Revisa específicamente las condiciones de cada nodo:

   ```bash
   for node in cp1 worker1 worker2; do
     echo "===== $node ====="
     kubectl get node "$node" \
       -o jsonpath='{range .status.conditions[*]}{.type}={.status}{" | "}{.reason}{"\n"}{end}'
     echo
   done
   ```

5. Inspecciona capacidad (`capacity`) y recursos asignables (`allocatable`):

   ```bash
   for node in cp1 worker1 worker2; do
     echo "===== Recursos de $node ====="
     kubectl describe node "$node" | sed -n '/Capacity:/,/System Info:/p'
     echo
   done
   ```

6. Revisa los recursos solicitados y límites asignados en un worker:

   ```bash
   kubectl describe node worker1 | sed -n '/Allocated resources:/,/Events:/p'
   ```

7. Guarda la evidencia:

   ```bash
   {
     echo "===== Nodos ====="
     kubectl get nodes -o wide
     echo
     echo "===== Etiquetas ====="
     kubectl get nodes --show-labels
     echo
     echo "===== Descripción cp1 ====="
     kubectl describe node cp1
     echo
     echo "===== Descripción worker1 ====="
     kubectl describe node worker1
     echo
     echo "===== Descripción worker2 ====="
     kubectl describe node worker2
   } > "$LAB_DIR/02-nodos-y-recursos.txt"
   ```

**Salida esperada:**

- Los nodos `cp1`, `worker1` y `worker2` aparecen en estado `Ready`.
- `cp1` posee el rol `control-plane`.
- Los workers no deben presentar presiones de memoria, disco o PID.
- Las condiciones relevantes deben indicar:

  ```text
  Ready=True
  MemoryPressure=False
  DiskPressure=False
  PIDPressure=False
  NetworkUnavailable=False
  ```

- Cada nodo debe tener direcciones internas consistentes con la topología del laboratorio.

**Verificación:**

Ejecuta el siguiente filtro:

```bash
kubectl get nodes \
  -o custom-columns=NAME:.metadata.name,READY:.status.conditions[?\(@.type==\"Ready\"\)].status,INTERNAL-IP:.status.addresses[?\(@.type==\"InternalIP\"\)].address
```

Confirma que los tres nodos reportan `READY=True` y las IP esperadas `10.10.10.10`, `10.10.10.11` y `10.10.10.12`.

---

### Paso 3. Inspeccionar los componentes Kubernetes del namespace `kube-system`

**Objetivo:** comprobar que los Pods críticos del sistema están presentes, programados y en estado saludable.

**Instrucciones:**

1. Lista todos los Pods del namespace del sistema:

   ```bash
   kubectl get pods -n kube-system -o wide
   ```

2. Agrupa los Pods por nodo para observar la distribución del plano de control, Calico, CoreDNS y kube-proxy:

   ```bash
   kubectl get pods -n kube-system -o wide \
     --sort-by=.spec.nodeName
   ```

3. Lista DaemonSets y Deployments críticos:

   ```bash
   kubectl get daemonsets -n kube-system
   kubectl get deployments -n kube-system
   ```

4. Inspecciona los Pods que se ejecutan en `cp1`:

   ```bash
   kubectl get pods -n kube-system -o wide \
     --field-selector spec.nodeName=cp1
   ```

5. Identifica los Pods estáticos del control plane mediante sus etiquetas y anotaciones:

   ```bash
   kubectl get pods -n kube-system \
     -l component=kube-apiserver -o yaml | sed -n '1,120p'

   kubectl get pods -n kube-system \
     -l component=kube-scheduler -o yaml | sed -n '1,120p'
   ```

6. Consulta eventos recientes del namespace:

   ```bash
   kubectl get events -n kube-system \
     --sort-by=.lastTimestamp | tail -n 40
   ```

7. Guarda la evidencia:

   ```bash
   {
     echo "===== Pods kube-system ====="
     kubectl get pods -n kube-system -o wide
     echo
     echo "===== DaemonSets kube-system ====="
     kubectl get daemonsets -n kube-system
     echo
     echo "===== Deployments kube-system ====="
     kubectl get deployments -n kube-system
     echo
     echo "===== Eventos recientes kube-system ====="
     kubectl get events -n kube-system --sort-by=.lastTimestamp
   } > "$LAB_DIR/03-kube-system.txt"
   ```

**Salida esperada:**

Deben aparecer, como mínimo, componentes equivalentes a los siguientes:

| Componente | Forma esperada | Ubicación esperada |
|---|---|---|
| `kube-apiserver-cp1` | Pod estático o mirror Pod | `cp1` |
| `kube-controller-manager-cp1` | Pod estático o mirror Pod | `cp1` |
| `kube-scheduler-cp1` | Pod estático o mirror Pod | `cp1` |
| `etcd-cp1` | Pod estático o mirror Pod | `cp1` |
| `kube-proxy-*` | DaemonSet | Un Pod por nodo |
| `calico-node-*` | DaemonSet | Un Pod por nodo |
| `calico-kube-controllers-*` | Deployment | Normalmente un Pod activo |
| `coredns-*` | Deployment | Normalmente en workers |

Los Pods críticos deben estar en estado `Running` y con contenedores `READY` según su definición.

**Verificación:**

Comprueba los DaemonSets principales:

```bash
kubectl get ds -n kube-system kube-proxy calico-node
```

El valor de `DESIRED`, `CURRENT`, `READY` y `AVAILABLE` debe reflejar los tres nodos del laboratorio. Si el nombre de Calico difiere, identifica el DaemonSet con:

```bash
kubectl get ds -n kube-system
```

---

### Paso 4. Relacionar los Pods estáticos con los manifiestos del control plane

**Objetivo:** demostrar que los componentes principales del plano de control son gestionados por el kubelet a partir de manifiestos estáticos locales, no por un Deployment convencional.

**Instrucciones:**

1. Desde `cp1`, lista los manifiestos estáticos:

   ```bash
   sudo ls -lah /etc/kubernetes/manifests/
   ```

2. Examina los nombres de los recursos definidos:

   ```bash
   sudo grep -E '^(kind:|  name:|    name:|    image:)' \
     /etc/kubernetes/manifests/*.yaml
   ```

3. Inspecciona el manifiesto del API Server y localiza el endpoint seguro:

   ```bash
   sudo grep -E -- '--secure-port|--advertise-address|--service-cluster-ip-range' \
     /etc/kubernetes/manifests/kube-apiserver.yaml
   ```

4. Inspecciona el manifiesto del controller manager para confirmar el Pod CIDR o parámetros de red relevantes:

   ```bash
   sudo grep -E -- '--cluster-cidr|--service-cluster-ip-range|--cluster-name' \
     /etc/kubernetes/manifests/kube-controller-manager.yaml
   ```

5. Inspecciona el manifiesto de etcd:

   ```bash
   sudo grep -E -- '--listen-client-urls|--advertise-client-urls|--data-dir' \
     /etc/kubernetes/manifests/etcd.yaml
   ```

6. Relaciona el manifiesto local con el mirror Pod observado desde la API:

   ```bash
   kubectl get pod kube-apiserver-cp1 -n kube-system -o jsonpath='{.metadata.annotations.kubernetes\.io/config\.mirror}{"\n"}'
   kubectl get pod etcd-cp1 -n kube-system -o jsonpath='{.metadata.annotations.kubernetes\.io/config\.mirror}{"\n"}'
   ```

7. Confirma que los puertos del plano de control están en escucha en `cp1`:

   ```bash
   sudo ss -lntp | grep -E ':(6443|2379|2380|10257|10259)\b'
   ```

8. Guarda la evidencia, excluyendo el contenido completo de certificados o claves:

   ```bash
   {
     echo "===== Manifiestos estáticos ====="
     sudo ls -lah /etc/kubernetes/manifests/
     echo
     echo "===== Parámetros API Server ====="
     sudo grep -E -- '--secure-port|--advertise-address|--service-cluster-ip-range' \
       /etc/kubernetes/manifests/kube-apiserver.yaml
     echo
     echo "===== Parámetros Controller Manager ====="
     sudo grep -E -- '--cluster-cidr|--service-cluster-ip-range|--cluster-name' \
       /etc/kubernetes/manifests/kube-controller-manager.yaml
     echo
     echo "===== Puertos escuchando ====="
     sudo ss -lntp | grep -E ':(6443|2379|2380|10257|10259)\b'
   } > "$LAB_DIR/04-control-plane-estatico.txt"
   ```

**Salida esperada:**

- El directorio `/etc/kubernetes/manifests/` contiene al menos:

  ```text
  etcd.yaml
  kube-apiserver.yaml
  kube-controller-manager.yaml
  kube-scheduler.yaml
  ```

- El API Server escucha en TCP `6443`.
- etcd escucha localmente en los puertos `2379` y `2380`, según su configuración.
- El mirror Pod de cada componente estático contiene una anotación `kubernetes.io/config.mirror`.
- Los manifiestos usan imágenes Kubernetes de la familia `v1.31.6`.

**Verificación:**

Ejecuta:

```bash
kubectl get pods -n kube-system \
  -l tier=control-plane \
  -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase
```

Los componentes del plano de control deben estar asociados al nodo `cp1` y en estado `Running`.

---

### Paso 5. Inspeccionar kubelet, containerd, CRI y directorios administrativos en `cp1`

**Objetivo:** validar que los servicios base del nodo de control están activos y que el kubelet se comunica con `containerd` mediante el endpoint CRI requerido.

**Instrucciones:**

1. Consulta el estado de los servicios del sistema:

   ```bash
   sudo systemctl status kubelet --no-pager
   sudo systemctl status containerd --no-pager
   ```

2. Confirma que ambos servicios están activos:

   ```bash
   systemctl is-active kubelet
   systemctl is-active containerd
   ```

3. Muestra la versión del kubelet y de containerd:

   ```bash
   kubelet --version
   containerd --version
   ```

4. Confirma el endpoint CRI usando `crictl`:

   ```bash
   sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock version
   ```

5. Lista contenedores administrados por el runtime y filtra componentes del control plane:

   ```bash
   sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock ps \
     | grep -E 'kube-apiserver|kube-controller-manager|kube-scheduler|etcd'
   ```

6. Comprueba la configuración de cgroups de containerd:

   ```bash
   sudo grep -n -A4 -B2 'SystemdCgroup' /etc/containerd/config.toml
   ```

7. Inspecciona directorios administrativos relevantes sin mostrar secretos:

   ```bash
   sudo ls -lah /etc/kubernetes/
   sudo ls -lah /var/lib/kubelet/
   sudo ls -lah /etc/cni/net.d/
   ```

8. Consulta las últimas entradas del kubelet:

   ```bash
   sudo journalctl -u kubelet -n 50 --no-pager
   ```

9. Guarda evidencia:

   ```bash
   {
     echo "===== kubelet ====="
     sudo systemctl status kubelet --no-pager
     echo
     echo "===== containerd ====="
     sudo systemctl status containerd --no-pager
     echo
     echo "===== Versiones ====="
     kubelet --version
     containerd --version
     echo
     echo "===== CRI version ====="
     sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock version
     echo
     echo "===== Control plane containers ====="
     sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock ps \
       | grep -E 'kube-apiserver|kube-controller-manager|kube-scheduler|etcd' || true
     echo
     echo "===== SystemdCgroup ====="
     sudo grep -n -A4 -B2 'SystemdCgroup' /etc/containerd/config.toml
   } > "$LAB_DIR/05-cp1-kubelet-containerd.txt"
   ```

**Salida esperada:**

- `kubelet` y `containerd` se encuentran en estado `active`.
- La versión del kubelet corresponde a `v1.31.6`.
- `containerd` corresponde a `1.7.24`.
- `crictl` se conecta correctamente a:

  ```text
  unix:///run/containerd/containerd.sock
  ```

- El archivo `/etc/containerd/config.toml` contiene una configuración equivalente a:

  ```toml
  SystemdCgroup = true
  ```

- Los contenedores del API Server, scheduler, controller manager y etcd son visibles mediante `crictl ps`.

**Verificación:**

Comprueba que el kubelet reconoce la ubicación de los manifiestos estáticos:

```bash
sudo grep -E 'staticPodPath|pod-manifest-path' \
  /var/lib/kubelet/config.yaml \
  /var/lib/kubelet/kubeadm-flags.env 2>/dev/null
```

Debe existir una referencia a `/etc/kubernetes/manifests`.

---

### Paso 6. Inspeccionar un nodo worker: kubelet, kube-proxy, containerd y CNI

**Objetivo:** validar los componentes que permiten a un worker recibir Pods, ejecutar contenedores y participar en la red del clúster.

**Instrucciones:**

1. Abre una segunda sesión SSH hacia `worker1`:

   ```bash
   ssh <usuario>@10.10.10.11
   ```

2. Confirma identidad y dirección del nodo:

   ```bash
   hostnamectl --static
   hostname -I
   ```

3. Consulta el estado de kubelet y containerd:

   ```bash
   sudo systemctl status kubelet --no-pager
   sudo systemctl status containerd --no-pager
   ```

4. Verifica el endpoint CRI y contenedores activos:

   ```bash
   sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock version
   sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock ps
   ```

5. Comprueba que el proceso kubelet está en ejecución:

   ```bash
   ps -ef | grep '[k]ubelet'
   ```

6. Inspecciona la configuración CNI instalada:

   ```bash
   sudo ls -lah /etc/cni/net.d/
   sudo find /etc/cni/net.d/ -maxdepth 1 -type f -print -exec sudo sed -n '1,80p' {} \;
   ```

7. Muestra interfaces asociadas a Calico y a la red overlay:

   ```bash
   ip -br link
   ip -br addr
   ip link show vxlan.calico 2>/dev/null || true
   ip link show tunl0 2>/dev/null || true
   ```

8. Inspecciona rutas hacia el Pod CIDR:

   ```bash
   ip route | grep -E '192\.168\.|vxlan\.calico|cali'
   ```

9. Examina el log reciente del kubelet para identificar mensajes de registro, CNI o sincronización de Pods:

   ```bash
   sudo journalctl -u kubelet -n 80 --no-pager
   ```

10. Desde `cp1`, en otra terminal con `KUBECONFIG` configurado, inspecciona el Pod `kube-proxy` y el Pod Calico ubicados en `worker1`:

    ```bash
    kubectl get pods -n kube-system -o wide \
      --field-selector spec.nodeName=worker1

    kubectl describe node worker1 | sed -n '/Non-terminated Pods:/,/Allocated resources:/p'
    ```

**Salida esperada:**

- `worker1` tiene hostname `worker1` e IP `10.10.10.11`.
- Los servicios `kubelet` y `containerd` están activos.
- `crictl` puede listar sandboxes y contenedores del nodo.
- Existe al menos una configuración CNI en `/etc/cni/net.d/`.
- Se observan interfaces Calico, como `vxlan.calico`, interfaces `cali*` u otras equivalentes según la configuración del clúster.
- La tabla de rutas incluye rutas relacionadas con `192.168.0.0/16`.
- En el worker existen Pods de `kube-proxy` y `calico-node`.

**Verificación:**

Desde `cp1`, verifica que el DaemonSet de kube-proxy tiene una instancia en `worker1`:

```bash
kubectl get pods -n kube-system -o wide \
  -l k8s-app=kube-proxy \
  --field-selector spec.nodeName=worker1
```

Si el selector no devuelve resultados, identifica las etiquetas reales:

```bash
kubectl get pods -n kube-system --show-labels | grep kube-proxy
```

---

### Paso 7. Consolidar la línea base operativa del clúster

**Objetivo:** generar un informe reutilizable que relacione el estado de nodos, red, control plane y componentes críticos antes de futuras tareas de mantenimiento.

**Instrucciones:**

1. Regresa a la sesión de `cp1` y asegura el kubeconfig administrativo:

   ```bash
   export KUBECONFIG=/etc/kubernetes/admin.conf
   ```

2. Obtén los CIDR configurados por kubeadm:

   ```bash
   kubectl -n kube-system get configmap kubeadm-config \
     -o jsonpath='{.data.ClusterConfiguration}' | \
     grep -E 'serviceSubnet|podSubnet|controlPlaneEndpoint'
   ```

3. Inspecciona la configuración de kube-proxy:

   ```bash
   kubectl -n kube-system get configmap kube-proxy \
     -o jsonpath='{.data.config\.conf}' | \
     grep -E 'mode:|clusterCIDR:|clusterDns:'
   ```

4. Identifica recursos Calico y confirma la existencia de una IPPool para el Pod CIDR:

   ```bash
   kubectl get pods -n kube-system -o wide | grep -i calico
   kubectl get crd | grep -E 'projectcalico|calico'
   ```

5. Si el recurso `ippools.crd.projectcalico.org` está disponible, consulta su CIDR:

   ```bash
   kubectl get ippools.crd.projectcalico.org -o yaml | \
     grep -E 'cidr:|ipipMode:|vxlanMode:'
   ```

6. Genera el informe de línea base:

   ```bash
   REPORT="$LAB_DIR/informe-linea-base-$(date -u +%Y%m%dT%H%M%SZ).txt"

   {
     echo "INFORME DE LÍNEA BASE - LAB 01-00-01"
     echo "Fecha UTC: $(date -u)"
     echo "Administrador: $(whoami)"
     echo

     echo "===== VERSIONES ====="
     kubectl version
     echo

     echo "===== ENDPOINT Y CONTEXTO ====="
     kubectl config current-context
     kubectl cluster-info
     echo

     echo "===== NODOS ====="
     kubectl get nodes -o wide
     echo

     echo "===== CONDICIONES DE NODOS ====="
     for node in cp1 worker1 worker2; do
       echo "--- $node ---"
       kubectl get node "$node" \
         -o jsonpath='{range .status.conditions[*]}{.type}={.status}{" | "}{.reason}{"\n"}{end}'
     done
     echo

     echo "===== CIDR KUBEADM ====="
     kubectl -n kube-system get configmap kubeadm-config \
       -o jsonpath='{.data.ClusterConfiguration}'
     echo
     echo

     echo "===== PODS CRÍTICOS ====="
     kubectl get pods -n kube-system -o wide
     echo

     echo "===== DAEMONSETS ====="
     kubectl get daemonsets -n kube-system
     echo

     echo "===== DEPLOYMENTS ====="
     kubectl get deployments -n kube-system
     echo

     echo "===== EVENTOS RECIENTES ====="
     kubectl get events -A --sort-by=.lastTimestamp | tail -n 80
     echo

     echo "===== ALERTAS IDENTIFICADAS ====="
     echo "Registrar manualmente Pods no Running, nodos no Ready,"
     echo "eventos Warning recurrentes, presiones de recursos o DaemonSets incompletos."
   } | tee "$REPORT"
   ```

7. Revisa el informe y registra observaciones concretas. Puedes añadirlas al final:

   ```bash
   nano "$REPORT"
   ```

   Incluye, como mínimo:

   - Estado de `cp1`, `worker1` y `worker2`.
   - Versiones observadas de Kubernetes y containerd.
   - Pod CIDR, Service CIDR y DNS de Services.
   - Estado de `calico-node`, `kube-proxy` y CoreDNS.
   - Estado de los Pods estáticos del plano de control.
   - Eventos `Warning` relevantes, si existen.
   - Cualquier diferencia respecto a los valores esperados.

**Salida esperada:**

El informe contiene evidencia reproducible de:

- Kubernetes `v1.31.6`.
- Endpoint del API Server `10.10.10.10:6443`.
- Tres nodos en condición `Ready`.
- Pod CIDR `192.168.0.0/16`.
- Service CIDR `10.96.0.0/12`.
- DNS de Services `10.96.0.10`.
- Componentes del plano de control en `cp1`.
- DaemonSets `kube-proxy` y `calico-node` desplegados en todos los nodos.
- Ausencia de alertas operativas críticas o registro explícito de las alertas encontradas.

**Verificación:**

Comprueba que el archivo existe y no está vacío:

```bash
ls -lh "$REPORT"
sed -n '1,80p' "$REPORT"
```

## Validación y pruebas

Ejecuta la siguiente lista de comprobación final desde `cp1`:

```bash
export KUBECONFIG=/etc/kubernetes/admin.conf

echo "===== 1. API Server ====="
kubectl get --raw=/readyz?verbose | tail -n 5

echo
echo "===== 2. Nodos ====="
kubectl get nodes -o wide

echo
echo "===== 3. Pods críticos ====="
kubectl get pods -n kube-system -o wide

echo
echo "===== 4. DaemonSets ====="
kubectl get ds -n kube-system

echo
echo "===== 5. Configuración kubeadm ====="
kubectl -n kube-system get cm kubeadm-config \
  -o jsonpath='{.data.ClusterConfiguration}' | \
  grep -E 'controlPlaneEndpoint|serviceSubnet|podSubnet'

echo
echo "===== 6. Eventos Warning recientes ====="
kubectl get events -A --field-selector type=Warning \
  --sort-by=.lastTimestamp | tail -n 20
```

Considera que la línea base es satisfactoria si se cumplen las siguientes condiciones:

| Comprobación | Criterio de aprobación |
|---|---|
| API Server | `/readyz` responde con verificaciones `ok` |
| Nodos | `cp1`, `worker1` y `worker2` están `Ready` |
| Control plane | API Server, scheduler, controller manager y etcd están `Running` en `cp1` |
| kubelet y containerd | Ambos servicios están `active` en los nodos inspeccionados |
| Runtime | `crictl` conecta con `unix:///run/containerd/containerd.sock` |
| Red Calico | `calico-node` está listo en todos los nodos |
| kube-proxy | Existe una instancia lista en cada nodo |
| CoreDNS | Sus Pods están `Running` y listos |
| CIDR | Pod CIDR `192.168.0.0/16` y Service CIDR `10.96.0.0/12` |
| Evidencia | Existe un informe de línea base almacenado en `$LAB_DIR` |

## Solución de problemas

### Incidencia 1: un nodo aparece como `NotReady`

**Síntomas:**

```bash
kubectl get nodes
```

Muestra un resultado similar a:

```text
worker1   NotReady   <none>   ...
```

Al inspeccionar el nodo:

```bash
kubectl describe node worker1
```

pueden aparecer condiciones como:

```text
Ready False KubeletNotReady
NetworkUnavailable True
```

**Causa probable:**

El kubelet no está activo, no puede comunicarse con `containerd`, o el plugin CNI Calico no está listo en el nodo.

**Corrección:**

1. Conéctate al worker afectado:

   ```bash
   ssh <usuario>@worker1
   ```

2. Comprueba los servicios:

   ```bash
   sudo systemctl status kubelet --no-pager
   sudo systemctl status containerd --no-pager
   ```

3. Revisa el log reciente del kubelet:

   ```bash
   sudo journalctl -u kubelet -n 100 --no-pager
   ```

4. Confirma el endpoint CRI:

   ```bash
   sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock version
   ```

5. Desde `cp1`, comprueba el Pod Calico correspondiente:

   ```bash
   kubectl get pods -n kube-system -o wide \
     --field-selector spec.nodeName=worker1
   ```

6. Si `containerd` está inactivo, inicia el diagnóstico revisando su log antes de realizar acciones correctivas:

   ```bash
   sudo journalctl -u containerd -n 100 --no-pager
   ```

7. Tras aplicar la corrección autorizada por el instructor, valida:

   ```bash
   kubectl get nodes
   ```

**Resultado esperado tras la corrección:**

El nodo vuelve a mostrar condición `Ready`, y los Pods `kube-proxy` y `calico-node` del nodo alcanzan estado `Running`.

### Incidencia 2: `crictl` no puede conectarse a containerd

**Síntomas:**

Al ejecutar:

```bash
sudo crictl ps
```

aparece un error similar a:

```text
connect: no such file or directory
```

o se intenta usar un socket CRI distinto al configurado en el laboratorio.

**Causa probable:**

`crictl` no tiene definido el endpoint CRI correcto, o `containerd` no está activo. El runtime requerido utiliza:

```text
unix:///run/containerd/containerd.sock
```

**Corrección:**

1. Verifica que el socket exista:

   ```bash
   sudo ls -lah /run/containerd/containerd.sock
   ```

2. Comprueba el servicio:

   ```bash
   sudo systemctl is-active containerd
   sudo systemctl status containerd --no-pager
   ```

3. Ejecuta `crictl` indicando explícitamente el endpoint correcto:

   ```bash
   sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock ps
   ```

4. Si se requiere una configuración persistente para `crictl`, revisa o crea `/etc/crictl.yaml`:

   ```bash
   sudo tee /etc/crictl.yaml >/dev/null <<'EOF'
   runtime-endpoint: unix:///run/containerd/containerd.sock
   image-endpoint: unix:///run/containerd/containerd.sock
   timeout: 10
   debug: false
   EOF
   ```

5. Valida nuevamente:

   ```bash
   sudo crictl version
   sudo crictl ps
   ```

**Resultado esperado tras la corrección:**

`crictl version` informa correctamente la versión del runtime y `crictl ps` lista los contenedores administrados por containerd.

## Limpieza

Esta práctica no crea Pods, Services, ConfigMaps ni otros recursos de Kubernetes, por lo que no requiere limpieza del clúster.

Conserva el directorio de evidencia para usarlo como línea base en la siguiente práctica:

```bash
ls -lah "$LAB_DIR"
```

Si el instructor solicita eliminar únicamente los archivos locales de evidencia, ejecuta:

```bash
rm -rf "$LAB_DIR"
unset KUBECONFIG LAB_DIR REPORT
```

No elimines archivos de `/etc/kubernetes/`, `/etc/cni/net.d/`, `/var/lib/kubelet/` ni `/etc/containerd/`.

## Resumen

En esta práctica verificaste el clúster desde la perspectiva CKA: infraestructura antes que aplicación. Confirmaste el acceso al API Server, inspeccionaste los nodos y sus condiciones, relacionaste los Pods estáticos con los manifiestos locales del control plane y validaste los servicios esenciales `kubelet` y `containerd`.

También examinaste el funcionamiento distribuido de `kube-proxy`, Calico y CoreDNS, así como interfaces y rutas relacionadas con el Pod CIDR. El informe generado constituye la línea base operativa que permitirá detectar cambios, regresiones o efectos no deseados durante operaciones de mantenimiento posteriores.

### Recursos opcionales

- [Arquitectura de clúster Kubernetes](https://kubernetes.io/docs/concepts/architecture/)
- [Pods estáticos](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
- [Administración de nodos](https://kubernetes.io/docs/concepts/architecture/nodes/)
- [Depuración de Kubernetes](https://kubernetes.io/docs/tasks/debug/debug-cluster/)
- [Documentación de kubeadm](https://kubernetes.io/docs/reference/setup-tools/kubeadm/)
- [Documentación de Calico](https://docs.tigera.io/calico/latest/getting-started/kubernetes/)
