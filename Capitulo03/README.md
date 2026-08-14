# 5 Práctica 3: Crear o validar un clúster con kubeadm y preparar nodos

## Metadatos

| Campo | Valor |
|---|---|
| Duración | 60 minutos |
| Complejidad | Difícil |
| Nivel de Bloom | Crear |

## Descripción general

En esta práctica se validará la configuración del clúster Kubernetes creado con `kubeadm` y se preparará un nuevo nodo trabajador denominado `worker3`. El trabajo incluye la comprobación del control plane existente, la configuración de los prerrequisitos Linux y de `containerd`, la unión segura del nodo mediante `kubeadm join` y la validación de red, DNS, kubelet, kube-proxy y scheduling.

La práctica utiliza la distinción administrativa esencial entre `kubeadm` para el ciclo de vida del clúster, `kubelet` para la operación local del nodo y `kubectl` para consultar y administrar recursos mediante el API Server.

## Objetivos de aprendizaje

Al finalizar esta práctica, podrá:

- [ ] Validar que el control plane existente utiliza Kubernetes `1.31.6`, el endpoint `10.10.10.10:6443`, el Pod CIDR `192.168.0.0/16` y el Service CIDR `10.96.0.0/12`.
- [ ] Preparar `worker3` con Ubuntu, `containerd`, módulos de kernel, parámetros `sysctl`, swap deshabilitada y componentes Kubernetes fijados por versión.
- [ ] Generar y ejecutar un comando `kubeadm join` con token temporal y hash CA verificable.
- [ ] Confirmar que `worker3` alcanza el estado `Ready`, ejecuta kubelet, kube-proxy y Calico correctamente.
- [ ] Programar y validar una carga de prueba en `worker3`, incluyendo conectividad mediante Service y resolución DNS.

## Prerrequisitos

### Conocimientos previos

- Comprender la función de `kubeadm`, `kubelet` y `kubectl`.
- Reconocer la diferencia entre un problema local del nodo y un problema observable desde la API de Kubernetes.
- Conocer comandos básicos de Linux: `systemctl`, `journalctl`, `ip`, `grep`, `tee` y edición de archivos.
- Haber completado la Práctica 2 con `cp1`, `worker1` y `worker2` saludables.

### Acceso requerido

- Acceso SSH o consola con privilegios `sudo` a `cp1`, `worker1`, `worker2` y `worker3`.
- Acceso administrativo a Kubernetes desde `cp1`.
- Conectividad entre nodos y hacia el endpoint `10.10.10.10:6443`.
- Acceso temporal al repositorio de paquetes Kubernetes `v1.31` y a los registros de imágenes requeridos, o equivalentes internos con las mismas versiones.
- Una VM nueva `worker3` con Ubuntu Server 24.04.2 LTS, IP `10.10.10.13/24`, hostname `worker3`, al menos 2 vCPU, 4 GB de RAM y 30 GB de almacenamiento libre.

> **Importante:** no use paquetes `latest`, no ejecute actualizaciones no controladas y no instale Docker Engine como runtime del clúster.

## Entorno de laboratorio

### Topología

| Nodo | Función | Dirección IPv4 | Hostname |
|---|---|---:|---|
| `cp1` | Control plane | `10.10.10.10/24` | `cp1` |
| `worker1` | Worker existente | `10.10.10.11/24` | `worker1` |
| `worker2` | Worker existente | `10.10.10.12/24` | `worker2` |
| `worker3` | Worker nuevo | `10.10.10.13/24` | `worker3` |

### Parámetros globales esperados

| Parámetro | Valor esperado |
|---|---|
| Kubernetes | `1.31.6-1.1` para `kubeadm`, `kubelet` y `kubectl` |
| Endpoint del API Server | `https://10.10.10.10:6443` |
| `controlPlaneEndpoint` | `10.10.10.10:6443` |
| Pod CIDR | `192.168.0.0/16` |
| Service CIDR | `10.96.0.0/12` |
| DNS de Services | `10.96.0.10` |
| CNI | Calico `3.29.2` |
| Runtime | `containerd 1.7.24-1` |
| Endpoint CRI | `unix:///run/containerd/containerd.sock` |
| Driver de cgroups | `SystemdCgroup = true` |

### Resolución local de nombres

Ejecute el siguiente bloque en **todos los nodos**, si no existe DNS interno que resuelva estos nombres:

```bash
sudo tee -a /etc/hosts >/dev/null <<'EOF'
10.10.10.10 cp1
10.10.10.11 worker1
10.10.10.12 worker2
10.10.10.13 worker3
EOF

getent hosts cp1 worker1 worker2 worker3
```

La salida debe asociar cada hostname con la dirección IP definida en la topología. Si ya existen entradas correctas, no añada duplicados.

---

## Procedimiento paso a paso

### Paso 1. Validar el estado inicial del clúster desde `cp1`

**Objetivo**

Confirmar que el clúster reutilizado desde la práctica anterior está saludable antes de incorporar un nodo adicional.

**Instrucciones**

1. Conéctese a `cp1` y configure el acceso administrativo si fuera necesario:

   ```bash
   export KUBECONFIG=/etc/kubernetes/admin.conf
   kubectl config current-context
   ```

2. Compruebe las versiones del cliente, del servidor y de las herramientas administrativas:

   ```bash
   kubeadm version
   kubelet --version
   kubectl version --client
   kubectl version --output=yaml
   ```

3. Revise el estado de los nodos y de los Pods del sistema:

   ```bash
   kubectl get nodes -o wide
   kubectl get pods -n kube-system -o wide
   ```

4. Valide que el API Server responde en el endpoint previsto:

   ```bash
   kubectl cluster-info
   kubectl get --raw=/readyz?verbose
   ```

**Salida esperada**

- `kubeadm version`, `kubelet --version` y `kubectl version --client` muestran versión `v1.31.6`.
- La información del servidor en `kubectl version --output=yaml` indica `gitVersion: v1.31.6`.
- `cp1`, `worker1` y `worker2` aparecen en estado `Ready`.
- Los Pods de CoreDNS, Calico y kube-proxy aparecen en ejecución o completados según corresponda.
- `kubectl cluster-info` muestra el API Server en `https://10.10.10.10:6443`.
- La consulta `/readyz?verbose` devuelve comprobaciones terminadas con `ok`.

**Verificación**

Ejecute:

```bash
kubectl get nodes
kubectl get pods -n kube-system
```

No continúe si algún nodo existente aparece como `NotReady` o si el API Server no está disponible. Corrija primero la salud del clúster base.

---

### Paso 2. Inspeccionar la configuración kubeadm y los static Pods del control plane

**Objetivo**

Validar que la configuración persistida por `kubeadm` coincide con los parámetros de red, endpoint y versión establecidos para el laboratorio.

**Instrucciones**

1. En `cp1`, consulte la configuración administrada por kubeadm:

   ```bash
   sudo kubeadm config view
   ```

2. Obtenga directamente la configuración del clúster almacenada en el ConfigMap `kubeadm-config`:

   ```bash
   kubectl -n kube-system get configmap kubeadm-config \
     -o jsonpath='{.data.ClusterConfiguration}'; echo
   ```

3. Filtre los valores que deben validarse:

   ```bash
   sudo kubeadm config view | grep -E \
     'kubernetesVersion|controlPlaneEndpoint|podSubnet|serviceSubnet|dnsDomain' || true

   kubectl -n kube-system get configmap kubeadm-config \
     -o jsonpath='{.data.ClusterConfiguration}' | grep -E \
     'kubernetesVersion|controlPlaneEndpoint|podSubnet|serviceSubnet|dnsDomain' || true
   ```

4. Inspeccione los manifiestos estáticos observados por el kubelet:

   ```bash
   sudo ls -lh /etc/kubernetes/manifests/
   sudo grep -E -- '--service-cluster-ip-range|--cluster-cidr|--advertise-address' \
     /etc/kubernetes/manifests/kube-apiserver.yaml \
     /etc/kubernetes/manifests/kube-controller-manager.yaml
   ```

5. Compruebe que el kubelet de `cp1` está activo y que administra los static Pods:

   ```bash
   sudo systemctl is-active kubelet
   sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock ps \
     | grep -E 'kube-apiserver|kube-controller-manager|kube-scheduler|etcd'
   ```

**Salida esperada**

La configuración debe contener valores equivalentes a los siguientes:

```yaml
kubernetesVersion: v1.31.6
controlPlaneEndpoint: 10.10.10.10:6443
networking:
  podSubnet: 192.168.0.0/16
  serviceSubnet: 10.96.0.0/12
```

Los manifiestos estáticos deben incluir, como mínimo:

- `kube-apiserver.yaml`
- `kube-controller-manager.yaml`
- `kube-scheduler.yaml`
- `etcd.yaml`

El manifiesto del API Server debe reflejar `--service-cluster-ip-range=10.96.0.0/12`, y el controller manager debe reflejar `--cluster-cidr=192.168.0.0/16`.

**Verificación**

Registre como evidencia técnica la salida de:

```bash
sudo kubeadm config view
sudo ls -lh /etc/kubernetes/manifests/
kubectl -n kube-system get configmap kubeadm-config -o yaml
```

Esta evidencia demuestra que `kubeadm` define el ciclo de vida y la configuración base, mientras que el kubelet mantiene los componentes de control plane definidos como static Pods.

---

### Paso 3. Validar conectividad y prerrequisitos básicos de `worker3`

**Objetivo**

Confirmar que `worker3` dispone de hostname, direccionamiento, resolución de nombres y conectividad hacia el control plane antes de instalar o unir componentes Kubernetes.

**Instrucciones**

1. Conéctese a `worker3` y compruebe el hostname:

   ```bash
   hostnamectl
   hostname
   ```

2. Si el hostname no es `worker3`, corríjalo y vuelva a iniciar sesión:

   ```bash
   sudo hostnamectl set-hostname worker3
   ```

3. Compruebe la dirección IP, la ruta por defecto y la resolución de nombres:

   ```bash
   ip -br address
   ip route
   getent hosts cp1 worker1 worker2 worker3
   ```

4. Compruebe conectividad TCP con el API Server:

   ```bash
   nc -vz 10.10.10.10 6443
   ```

5. Revise la hora del sistema. La sincronización de tiempo evita problemas de certificados y autenticación:

   ```bash
   timedatectl status
   ```

**Salida esperada**

- El hostname activo es `worker3`.
- La interfaz de red tiene la dirección `10.10.10.13/24`.
- Existe una ruta por defecto válida.
- `cp1` se resuelve como `10.10.10.10`.
- La comprobación `nc` informa que la conexión a `10.10.10.10:6443` fue exitosa.
- El reloj del sistema está sincronizado o tiene un estado de sincronización activo.

**Verificación**

Ejecute:

```bash
hostname
getent hosts cp1
nc -vz 10.10.10.10 6443
```

Los tres comandos deben completarse correctamente antes de continuar. La unión con `kubeadm` no podrá registrar el nodo si el API Server no es alcanzable.

---

### Paso 4. Preparar kernel, swap y parámetros de red en `worker3`

**Objetivo**

Configurar los prerrequisitos Linux requeridos por kubelet, containerd y el CNI Calico.

**Instrucciones**

1. Deshabilite swap inmediatamente y elimine su activación persistente en `/etc/fstab`:

   ```bash
   sudo swapoff -a
   sudo cp /etc/fstab /etc/fstab.pre-kubernetes
   sudo sed -i '/\sswap\s/s/^\(.*\)$/# \1/g' /etc/fstab
   free -h
   swapon --show
   ```

2. Cargue los módulos de kernel requeridos:

   ```bash
   sudo tee /etc/modules-load.d/k8s.conf >/dev/null <<'EOF'
   overlay
   br_netfilter
   EOF

   sudo modprobe overlay
   sudo modprobe br_netfilter
   lsmod | grep -E 'overlay|br_netfilter'
   ```

3. Configure los parámetros `sysctl` para forwarding IPv4 y tráfico puenteado por netfilter:

   ```bash
   sudo tee /etc/sysctl.d/k8s.conf >/dev/null <<'EOF'
   net.bridge.bridge-nf-call-iptables = 1
   net.bridge.bridge-nf-call-ip6tables = 1
   net.ipv4.ip_forward = 1
   EOF

   sudo sysctl --system
   ```

4. Compruebe los valores efectivos:

   ```bash
   sysctl net.bridge.bridge-nf-call-iptables
   sysctl net.bridge.bridge-nf-call-ip6tables
   sysctl net.ipv4.ip_forward
   ```

**Salida esperada**

- `swapon --show` no produce ninguna línea de salida.
- `lsmod` muestra los módulos `overlay` y `br_netfilter`.
- Los tres parámetros `sysctl` presentan valor `1`.
- No se muestran errores al ejecutar `sudo sysctl --system`.

**Verificación**

Ejecute el siguiente bloque:

```bash
test -z "$(swapon --show)" && echo "Swap deshabilitada"
lsmod | grep -E 'overlay|br_netfilter'
sysctl net.ipv4.ip_forward
```

La swap debe permanecer deshabilitada incluso después de un reinicio, debido a la modificación persistente de `/etc/fstab`.

---

### Paso 5. Instalar y configurar containerd y los binarios Kubernetes en `worker3`

**Objetivo**

Instalar versiones fijadas de `containerd`, `kubeadm`, `kubelet` y `kubectl`, configurando el runtime CRI con cgroups administrados por systemd.

**Instrucciones**

1. Instale `containerd` en la versión aprobada por el entorno o desde el repositorio interno equivalente:

   ```bash
   sudo apt-get update
   sudo apt-get install -y containerd=1.7.24-1
   ```

2. Genere una configuración base de containerd y active `SystemdCgroup`:

   ```bash
   sudo mkdir -p /etc/containerd
   containerd config default | sudo tee /etc/containerd/config.toml >/dev/null

   sudo sed -i \
     's/SystemdCgroup = false/SystemdCgroup = true/' \
     /etc/containerd/config.toml

   grep -n 'SystemdCgroup' /etc/containerd/config.toml
   ```

3. Confirme que el plugin CRI no está deshabilitado. La lista `disabled_plugins` no debe contener `"cri"`:

   ```bash
   grep -nE 'disabled_plugins|cri' /etc/containerd/config.toml | head -n 20
   ```

4. Reinicie y habilite containerd:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now containerd
   sudo systemctl restart containerd
   sudo systemctl is-active containerd
   ```

5. Configure el repositorio Kubernetes `v1.31`, si todavía no está configurado en `worker3`:

   ```bash
   sudo apt-get install -y ca-certificates curl gpg
   sudo install -m 0755 -d /etc/apt/keyrings

   curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key \
     | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg

   sudo chmod 0644 /etc/apt/keyrings/kubernetes-apt-keyring.gpg

   echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' \
     | sudo tee /etc/apt/sources.list.d/kubernetes.list
   ```

6. Instale las versiones exactas requeridas y evite actualizaciones accidentales:

   ```bash
   sudo apt-get update
   sudo apt-get install -y \
     kubelet=1.31.6-1.1 \
     kubeadm=1.31.6-1.1 \
     kubectl=1.31.6-1.1

   sudo apt-mark hold kubelet kubeadm kubectl containerd
   ```

7. Compruebe versiones, estado del runtime y endpoint CRI:

   ```bash
   kubeadm version
   kubelet --version
   kubectl version --client
   sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock version
   sudo systemctl status containerd --no-pager
   ```

**Salida esperada**

- `containerd` está en estado `active (running)`.
- El archivo `/etc/containerd/config.toml` contiene `SystemdCgroup = true`.
- `crictl` puede comunicarse con `unix:///run/containerd/containerd.sock`.
- Los binarios Kubernetes informan versión `v1.31.6`.
- `apt-mark hold` confirma que los paquetes quedan retenidos.

> **Nota:** antes de ejecutar `kubeadm join`, es normal que `kubelet` se reinicie repetidamente o registre que aún no encuentra su configuración. El archivo `/var/lib/kubelet/config.yaml` se completa durante la unión.

**Verificación**

Ejecute:

```bash
sudo systemctl is-active containerd
grep 'SystemdCgroup = true' /etc/containerd/config.toml
kubeadm version
kubelet --version
apt-mark showhold | grep -E 'kubelet|kubeadm|kubectl|containerd'
```

Todos los resultados deben corresponder a las versiones y configuraciones previstas.

---

### Paso 6. Generar un comando de unión controlado desde `cp1`

**Objetivo**

Crear un token de unión temporal y obtener un hash de clave pública de la CA para incorporar `worker3` de forma verificable.

**Instrucciones**

1. Vuelva a `cp1` y liste los tokens existentes:

   ```bash
   sudo kubeadm token list
   ```

2. Calcule el hash de la CA del clúster. Este valor debe poder verificarse localmente y no debe sustituirse por valores copiados de otro clúster:

   ```bash
   openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt \
     | openssl rsa -pubin -outform der 2>/dev/null \
     | openssl dgst -sha256 -hex \
     | sed 's/^.* //'
   ```

3. Genere un comando de unión con expiración de dos horas:

   ```bash
   sudo kubeadm token create --ttl 2h --print-join-command
   ```

4. Guarde el comando temporalmente en una sesión protegida o transfiéralo mediante un canal administrativo seguro a `worker3`.

5. Compruebe que el comando generado contiene los elementos siguientes:

   ```text
   kubeadm join 10.10.10.10:6443
   --token <token-temporal>
   --discovery-token-ca-cert-hash sha256:<hash-ca>
   ```

**Salida esperada**

- `kubeadm token list` muestra tokens activos y su expiración.
- El hash calculado tiene formato hexadecimal SHA-256.
- `--print-join-command` genera una instrucción dirigida a `10.10.10.10:6443`.
- El comando contiene `--discovery-token-ca-cert-hash sha256:`.

**Verificación**

Compare el hash resultante del paso 2 con el hash contenido en el comando de unión. Deben coincidir exactamente.

> **Seguridad:** el token de bootstrap concede capacidad temporal de unión. No publique el comando completo en documentación compartida, historiales públicos, capturas de pantalla o repositorios Git.

---

### Paso 7. Unir `worker3` al clúster y comprobar el registro del nodo

**Objetivo**

Ejecutar `kubeadm join` en `worker3`, registrar el kubelet ante el API Server y esperar a que Calico complete la configuración de red.

**Instrucciones**

1. En `worker3`, ejecute el comando generado en el paso anterior. Sustituya los marcadores por los valores reales:

   ```bash
   sudo kubeadm join 10.10.10.10:6443 \
     --token <TOKEN_TEMPORAL> \
     --discovery-token-ca-cert-hash sha256:<HASH_CA>
   ```

2. Cuando el comando finalice, revise el estado local de kubelet:

   ```bash
   sudo systemctl status kubelet --no-pager
   sudo journalctl -u kubelet -n 50 --no-pager
   ```

3. Desde `cp1`, supervise la aparición de `worker3`:

   ```bash
   export KUBECONFIG=/etc/kubernetes/admin.conf
   kubectl get nodes -w
   ```

4. En otra terminal de `cp1`, observe los Pods del nuevo nodo:

   ```bash
   kubectl get pods -n kube-system -o wide \
     --field-selector spec.nodeName=worker3
   ```

5. Espere hasta que el Pod de Calico y el Pod de kube-proxy de `worker3` estén en estado `Running`, y que el nodo alcance el estado `Ready`.

6. Etiquete el nodo después de que esté preparado:

   ```bash
   kubectl label node worker3 node-role.kubernetes.io/worker=worker
   kubectl label node worker3 training.example.io/lifecycle=joined
   ```

**Salida esperada**

El comando `kubeadm join` termina con un mensaje similar a:

```text
This node has joined the cluster:
* Certificate signing request was sent to apiserver and a response was received.
* The Kubelet was informed of the new secure connection details.
```

Posteriormente:

- `worker3` aparece en `kubectl get nodes`.
- El estado evoluciona de `NotReady` a `Ready`.
- Hay un Pod `kube-proxy` en `worker3`.
- Hay un Pod de Calico en `worker3`.
- Las etiquetas solicitadas aparecen en los metadatos del nodo.

**Verificación**

Ejecute desde `cp1`:

```bash
kubectl get node worker3 -o wide
kubectl get node worker3 --show-labels
kubectl get pods -n kube-system -o wide \
  --field-selector spec.nodeName=worker3
kubectl describe node worker3
```

Confirme especialmente:

- `Ready=True` en las condiciones del nodo.
- `containerRuntimeVersion` asociado con containerd.
- Dirección interna `10.10.10.13`.
- Presencia de `kube-proxy` y Calico.
- Etiquetas `node-role.kubernetes.io/worker=worker` y `training.example.io/lifecycle=joined`.

---

### Paso 8. Programar una carga de prueba en `worker3` y validar red y DNS

**Objetivo**

Demostrar que `worker3` puede ejecutar una carga, recibir un Pod mediante scheduling y participar en conectividad entre Pods, Services y CoreDNS.

**Instrucciones**

1. Desde `cp1`, cree un namespace aislado para las pruebas:

   ```bash
   kubectl create namespace lab03-test
   ```

2. Cree un Deployment HTTP fijado explícitamente a `worker3`, un Service y un Pod de diagnóstico fijado a `worker1`:

   ```bash
   cat <<'EOF' | kubectl apply -f -
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: web-worker3
     namespace: lab03-test
   spec:
     replicas: 1
     selector:
       matchLabels:
         app: web-worker3
     template:
       metadata:
         labels:
           app: web-worker3
       spec:
         nodeSelector:
           kubernetes.io/hostname: worker3
         containers:
         - name: web
           image: busybox:1.36.1
           command:
           - sh
           - -c
           - |
             echo "worker3 web service ready" > /www/index.html
             httpd -f -p 8080 -h /www
           ports:
           - containerPort: 8080
   ---
   apiVersion: v1
   kind: Service
   metadata:
     name: web-worker3
     namespace: lab03-test
   spec:
     selector:
       app: web-worker3
     ports:
     - port: 8080
       targetPort: 8080
   ---
   apiVersion: v1
   kind: Pod
   metadata:
     name: diag-worker1
     namespace: lab03-test
   spec:
     nodeSelector:
       kubernetes.io/hostname: worker1
     restartPolicy: Never
     containers:
     - name: diag
       image: busybox:1.36.1
       command:
       - sh
       - -c
       - sleep 3600
   EOF
   ```

3. Espere a que ambos Pods estén disponibles:

   ```bash
   kubectl -n lab03-test rollout status deployment/web-worker3 --timeout=120s
   kubectl -n lab03-test wait --for=condition=Ready pod/diag-worker1 --timeout=120s
   kubectl -n lab03-test get pods -o wide
   ```

4. Compruebe que la carga HTTP fue programada en `worker3` y que el Pod de diagnóstico está en `worker1`:

   ```bash
   kubectl -n lab03-test get pods -o wide
   kubectl -n lab03-test get endpoints web-worker3
   kubectl -n lab03-test get endpointslices \
     -l kubernetes.io/service-name=web-worker3
   ```

5. Desde el Pod de diagnóstico, valide DNS de Kubernetes y resolución del Service:

   ```bash
   kubectl -n lab03-test exec diag-worker1 -- nslookup kubernetes.default.svc.cluster.local
   kubectl -n lab03-test exec diag-worker1 -- nslookup web-worker3.lab03-test.svc.cluster.local
   ```

6. Valide conectividad a través del Service:

   ```bash
   kubectl -n lab03-test exec diag-worker1 -- \
     wget -qO- http://web-worker3.lab03-test.svc.cluster.local:8080/
   ```

7. Obtenga evidencia adicional de kube-proxy, Calico y kubelet:

   ```bash
   kubectl -n kube-system get pods -o wide \
     --field-selector spec.nodeName=worker3

   ssh worker3 'sudo systemctl is-active kubelet && sudo systemctl is-active containerd'
   ```

**Salida esperada**

- El Pod controlado por el Deployment `web-worker3` se ejecuta en `worker3`.
- `diag-worker1` se ejecuta en `worker1`.
- El Service `web-worker3` tiene al menos un endpoint correspondiente a la IP del Pod en `worker3`.
- Las consultas `nslookup` resuelven el DNS del clúster y el nombre del Service.
- La consulta HTTP devuelve:

```text
worker3 web service ready
```

- `kubelet` y `containerd` están activos en `worker3`.

**Verificación**

Ejecute el bloque consolidado:

```bash
kubectl -n lab03-test get pods -o wide
kubectl -n lab03-test get svc,endpoints
kubectl -n lab03-test exec diag-worker1 -- \
  wget -qO- http://web-worker3.lab03-test.svc.cluster.local:8080/
kubectl get node worker3
```

La evidencia debe demostrar el recorrido completo: scheduler asigna la carga, kubelet materializa el Pod, Calico configura conectividad, kube-proxy implementa el Service y CoreDNS resuelve el nombre del Service.

---

### Paso 9. Documentar el flujo administrativo de una actualización futura

**Objetivo**

Registrar el orden correcto para una actualización futura de Kubernetes con kubeadm sin realizar una actualización real en esta práctica.

**Instrucciones**

1. En `cp1`, confirme las versiones actualmente instaladas:

   ```bash
   kubeadm version
   kubelet --version
   kubectl version --client
   kubectl version --output=yaml
   ```

2. Revise el plan de actualización de forma informativa. Este comando no aplica una actualización:

   ```bash
   sudo kubeadm upgrade plan --kubeconfig /etc/kubernetes/admin.conf
   ```

3. Documente el orden administrativo correcto para una actualización futura:

   ```text
   1. Revisar compatibilidad de Kubernetes, containerd, Calico y complementos CSI.
   2. Respaldar información crítica y validar la salud del control plane.
   3. Actualizar kubeadm en cp1 a la versión objetivo permitida.
   4. Ejecutar kubeadm upgrade plan.
   5. Ejecutar kubeadm upgrade apply <versión-objetivo> en el control plane.
   6. Actualizar kubelet y kubectl en cp1; reiniciar kubelet y validar.
   7. Drenar un worker: kubectl drain <nodo> --ignore-daemonsets --delete-emptydir-data.
   8. Actualizar kubeadm y aplicar kubeadm upgrade node en el worker drenado.
   9. Actualizar kubelet y kubectl en el worker; reiniciar kubelet.
   10. Reactivar el nodo con kubectl uncordon <nodo>.
   11. Repetir secuencialmente para cada worker y validar workloads, red, DNS y almacenamiento.
   ```

4. No ejecute `kubeadm upgrade apply`, no cambie versiones de paquetes y no drene nodos durante esta práctica.

**Salida esperada**

- `kubeadm upgrade plan` muestra el estado actual y, si existe conectividad a la fuente de versiones, posibles rutas de actualización.
- No cambian las versiones instaladas.
- El clúster mantiene sus cuatro nodos en estado `Ready`.

**Verificación**

Ejecute:

```bash
kubectl get nodes
kubectl get pods -A -o wide
apt-mark showhold | grep -E 'kubelet|kubeadm|kubectl|containerd'
```

Confirme que no se realizó ningún cambio de versión y que los paquetes críticos permanecen retenidos.

## Validación y pruebas

Complete la siguiente lista de validación final desde `cp1`:

```bash
export KUBECONFIG=/etc/kubernetes/admin.conf

echo "=== Nodos ==="
kubectl get nodes -o wide

echo "=== Etiquetas de worker3 ==="
kubectl get node worker3 --show-labels

echo "=== Componentes de sistema en worker3 ==="
kubectl get pods -n kube-system -o wide \
  --field-selector spec.nodeName=worker3

echo "=== Condiciones de worker3 ==="
kubectl describe node worker3 | sed -n '/Conditions:/,/Addresses:/p'

echo "=== Carga de prueba ==="
kubectl -n lab03-test get pods,svc,endpoints -o wide

echo "=== DNS y Service ==="
kubectl -n lab03-test exec diag-worker1 -- \
  nslookup web-worker3.lab03-test.svc.cluster.local

kubectl -n lab03-test exec diag-worker1 -- \
  wget -qO- http://web-worker3.lab03-test.svc.cluster.local:8080/
```

La práctica se considera validada si se cumplen todas las condiciones siguientes:

| Validación | Resultado esperado |
|---|---|
| Estado del clúster | `cp1`, `worker1`, `worker2` y `worker3` en `Ready` |
| Versión Kubernetes | `v1.31.6` para cliente, kubelet y control plane |
| Runtime de `worker3` | `containerd 1.7.24-1`, CRI operativo y cgroups systemd |
| Etiquetas | `worker3` tiene rol worker y lifecycle `joined` |
| Red del nodo | Pod de Calico ejecutándose en `worker3` |
| Proxy de Services | Pod kube-proxy ejecutándose en `worker3` |
| Scheduling | `web-worker3` programado en `worker3` |
| DNS | `diag-worker1` resuelve el Service de `lab03-test` |
| Conectividad | La consulta HTTP mediante el Service devuelve el contenido esperado |

## Resolución de problemas

### Problema 1: `kubeadm join` falla o `worker3` permanece en `NotReady`

**Síntomas**

- `kubeadm join` muestra errores relacionados con descubrimiento, token, hash CA o conexión con el API Server.
- `worker3` aparece brevemente y después permanece en `NotReady`.
- `journalctl -u kubelet` contiene mensajes sobre imposibilidad de registrar el nodo o conectar con `10.10.10.10:6443`.

**Causa probable**

El token expiró, el hash CA no pertenece al clúster actual, el endpoint del API Server no es alcanzable, la hora del sistema está desincronizada o el runtime/containerd no está disponible correctamente.

**Corrección**

1. En `worker3`, compruebe conectividad y servicios:

   ```bash
   nc -vz 10.10.10.10 6443
   sudo systemctl status containerd kubelet --no-pager
   sudo journalctl -u kubelet -n 100 --no-pager
   timedatectl status
   ```

2. En `cp1`, genere un token nuevo y vuelva a calcular el hash:

   ```bash
   sudo kubeadm token create --ttl 2h --print-join-command

   openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt \
     | openssl rsa -pubin -outform der 2>/dev/null \
     | openssl dgst -sha256 -hex \
     | sed 's/^.* //'
   ```

3. Si la unión falló parcialmente y debe repetirse, limpie únicamente el estado de unión en `worker3`:

   ```bash
   sudo kubeadm reset -f
   sudo rm -rf /etc/cni/net.d
   sudo systemctl restart containerd
   ```

4. Ejecute de nuevo el comando de unión recién generado. No ejecute `kubeadm reset` en `cp1`.

### Problema 2: El nodo está `Ready`, pero el Pod de prueba no tiene conectividad o el Service no resuelve

**Síntomas**

- `web-worker3` está en ejecución, pero `wget` desde `diag-worker1` falla.
- `nslookup web-worker3.lab03-test.svc.cluster.local` no resuelve.
- El Service no muestra endpoints.
- El Pod de Calico o kube-proxy de `worker3` no está en `Running`.

**Causa probable**

Calico no completó la configuración del nodo, kube-proxy no está disponible, el selector del Service no coincide con las etiquetas del Pod, o CoreDNS presenta errores de disponibilidad o resolución.

**Corrección**

1. Revise Pods y eventos relevantes:

   ```bash
   kubectl get pods -n kube-system -o wide
   kubectl get events -A --sort-by=.lastTimestamp | tail -n 50
   kubectl -n lab03-test get pods --show-labels
   kubectl -n lab03-test get svc,endpoints,endpointslices
   ```

2. Confirme que el selector y la etiqueta coinciden:

   ```bash
   kubectl -n lab03-test get svc web-worker3 -o yaml
   kubectl -n lab03-test get pod -l app=web-worker3 --show-labels
   ```

3. Revise Calico, kube-proxy y CoreDNS:

   ```bash
   kubectl -n kube-system get pods -o wide | grep -E 'calico|kube-proxy|coredns'
   kubectl -n kube-system logs -l k8s-app=calico-node --tail=100
   kubectl -n kube-system logs -l k8s-app=kube-proxy --tail=100
   kubectl -n kube-system logs -l k8s-app=kube-dns --tail=100
   ```

4. En `worker3`, confirme módulos, forwarding y kubelet:

   ```bash
   lsmod | grep -E 'overlay|br_netfilter'
   sysctl net.ipv4.ip_forward
   sudo systemctl status kubelet containerd --no-pager
   ```

5. Si el selector no coincide, corrija las etiquetas o el selector. Si Calico o kube-proxy no están saludables, revise sus eventos y logs antes de reiniciar componentes sin diagnóstico.

## Limpieza

La incorporación de `worker3` es persistente y forma parte del resultado esperado de la práctica. No ejecute `kubeadm reset` ni elimine el nodo.

Elimine únicamente los recursos temporales de validación:

```bash
kubectl delete namespace lab03-test
```

Opcionalmente, compruebe que no quedan recursos de prueba:

```bash
kubectl get namespace lab03-test
kubectl get nodes
```

Si guardó el comando `kubeadm join` en un archivo temporal, elimínelo de forma segura:

```bash
rm -f ~/worker3-join-command.txt
history -d $((HISTCMD-1)) 2>/dev/null || true
```

## Resumen

En esta práctica se validó un clúster kubeadm existente y se incorporó `worker3` como nodo trabajador. Se comprobó la configuración del control plane mediante `kubeadm config view`, ConfigMaps y manifiestos estáticos, verificando endpoint, versiones y rangos de red.

También se configuraron los prerrequisitos Linux del nodo nuevo, incluyendo swap deshabilitada, módulos de kernel, parámetros `sysctl`, `containerd` con `SystemdCgroup = true` y paquetes Kubernetes fijados a `1.31.6-1.1`. Finalmente, se usó `kubeadm join` con token temporal y hash de CA verificable, y se validó que kubelet, Calico, kube-proxy, CoreDNS, Services y scheduling operan correctamente.

La secuencia administrativa recordada para futuras actualizaciones es: planificar y actualizar primero el control plane con `kubeadm`, actualizar kubelet y kubectl, y después drenar, actualizar y reactivar cada worker de forma secuencial.

### Recursos adicionales

- [Documentación oficial de kubeadm](https://kubernetes.io/docs/reference/setup-tools/kubeadm/)
- [Creación de clústeres con kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/)
- [Administración de nodos Kubernetes](https://kubernetes.io/docs/concepts/architecture/nodes/)
- [Documentación de Calico](https://docs.tigera.io/calico/latest/about/)
