---
layout: lab
title: "Práctica 1: Inspección completa de un clúster Kubernetes"
permalink: /lab1/lab1/
images_base: /labs/lab1/img
duration: "50 minutos"
objective:
  - Inspeccionar de forma sistemática un clúster Kubernetes administrado con kubeadm, identificando nodos, componentes del control plane, runtime, servicios internos, almacenamiento y señales básicas de salud sin modificar su estado.
prerequisites:
  - Acceso por SSH a las máquinas virtuales cka-control y cka-worker1.
  - Clúster Kubernetes v1.35.x operativo con cka-control y cka-worker1 en estado Ready.
  - cka-worker2 preparado pero todavía no unido al clúster.
  - kubectl, kubeadm, kubelet y crictl disponibles según el rol de cada nodo.
  - Conocimientos básicos de kubectl, YAML y administración Linux.
introduction:
  - En esta práctica inspeccionarás un clúster Kubernetes real creado con kubeadm desde la perspectiva de un administrador. Seguirás una ruta de diagnóstico que parte del contexto de acceso, continúa con nodos y componentes del control plane, desciende al kubelet y al runtime del worker y termina validando CNI, DNS, almacenamiento y salud general del clúster. La práctica es completamente guiada y no realiza cambios deliberados sobre la infraestructura.
slug: lab1
lab_number: 1
final_result: >
  Al finalizar habrás identificado la topología del clúster, diferenciado el control plane de los workers, relacionado los static Pods con sus manifiestos y con containerd, comprobado el estado de kubelet, CNI, CoreDNS, kube-proxy, etcd y StorageClass, y validado que el API Server y los nodos se encuentran operativos antes de realizar tareas administrativas posteriores.
notes:
  - Ejecuta los comandos exactamente en el nodo indicado. La práctica alterna entre cka-control y cka-worker1 mediante SSH.
  - cka-worker2 no debe aparecer todavía en kubectl get nodes; se mantiene preparado y fuera del clúster para una práctica posterior con kubeadm join.
  - Esta práctica es de inspección. No edites manifiestos, no elimines Pods del sistema y no ejecutes comandos de mantenimiento sobre los nodos.
  - Las direcciones de acceso desde Windows son 192.168.10.100 para cka-control y 192.168.10.101 para cka-worker1; la red privada del clúster utiliza 10.10.10.0/24.
references:
  - text: Arquitectura de clústeres Kubernetes
    url: https://kubernetes.io/docs/concepts/architecture/
  - text: Referencia de kubectl
    url: https://kubernetes.io/docs/reference/kubectl/
  - text: Administración de clústeres Kubernetes
    url: https://kubernetes.io/docs/tasks/administer-cluster/
prev: /
next: /lab2/lab2/
---

---

<!-- Aquí comienzan las instrucciones paso a paso de la práctica -->

## 🔎 Tarea 1. Acceso al entorno y contexto administrativo — 7 min

Accederás al control plane, confirmarás que trabajas sobre la VM correcta y revisarás el contexto de kubectl y las versiones administrativas disponibles. El objetivo es saber con precisión qué clúster, usuario y herramientas estás utilizando antes de comenzar cualquier inspección.

### Tarea 1.1. Conectarse al control plane e identificar el host

Establecerás la sesión administrativa inicial desde Windows y confirmarás el hostname y las interfaces de red visibles en el nodo de control.

- {% include step_label.html %} Desde Windows Terminal, PowerShell o Git Bash, abre una sesión SSH hacia el control plane.

  ```bash
  ssh control@192.168.10.100
  ```

  > **Salida esperada:** La sesión inicia correctamente y el prompt corresponde al usuario `control` en `cka-control`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Confirma el nombre del nodo en el que estás trabajando.

  ```bash
  hostname
  ```

  > **Salida esperada:** El comando muestra `cka-control`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Identifica las interfaces y direcciones IP configuradas en el nodo.

  ```bash
  ip -br addr
  ```

  > **Salida esperada:** Debes identificar una interfaz en la red privada `10.10.10.0/24` con la dirección `10.10.10.10` y otra dirección utilizada para acceso desde Windows.
  {: .lab-note .output .compact}

### Tarea 1.2. Identificar el contexto de kubectl

Comprobarás qué contexto utiliza kubectl y qué endpoint representa el clúster actual antes de consultar recursos administrativos.

- {% include step_label.html %} Consulta el contexto activo de kubectl.

  ```bash
  kubectl config current-context
  ```

  > **Salida esperada:** Se muestra `kubernetes-admin@kubernetes`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Lista los contextos disponibles y confirma cuál está marcado como actual.

  ```bash
  kubectl config get-contexts
  ```

  > **Salida esperada:** El contexto activo aparece marcado con `*` y referencia al clúster y usuario administrativos configurados.
  {: .lab-note .output .compact}

### Tarea 1.3. Verificar acceso y versiones administrativas

Confirmarás que kubectl puede comunicarse con el API Server y revisarás las versiones de las herramientas principales del entorno.

- {% include step_label.html %} Comprueba que kubectl puede localizar el API Server y CoreDNS.

  ```bash
  kubectl cluster-info
  ```

  > **Salida esperada:** Se muestran las direcciones del Kubernetes control plane y del servicio CoreDNS sin errores de conexión.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta las versiones de kubectl, kubeadm y kubelet instaladas en el control plane.

  ```bash
  kubectl version --client
  kubeadm version -o short
  kubelet --version
  ```

  > **Salida esperada:** Las herramientas reportan versiones de Kubernetes v1.35.x; en el entorno preparado se utiliza v1.35.8.
  {: .lab-note .output .compact}

{% assign results = site.data.task-results[page.slug].results %}
{% capture r1 %}{{ results[0] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r1 %}

{% include support-prompt.html task="tarea1" %}

---

## 🖥️ Tarea 2. Inspección de nodos y capacidad — 10 min

Examinarás los nodos registrados, sus direcciones, roles, condiciones, recursos asignables, labels y taints. Esta lectura permite establecer una línea base administrativa antes de realizar mantenimiento o scheduling en prácticas posteriores.

### Tarea 2.1. Revisar el inventario de nodos

Identificarás qué nodos pertenecen actualmente al clúster y compararás su rol, versión, red interna y runtime.

- {% include step_label.html %} Lista los nodos registrados en el clúster.

  ```bash
  kubectl get nodes
  ```

  > **Salida esperada:** Aparecen `cka-control` y `cka-worker1` en estado `Ready`. `cka-worker2` no debe aparecer todavía.
  {: .lab-note .output .compact}

- {% include step_label.html %} Amplía la consulta para observar IP interna, sistema operativo y container runtime.

  ```bash
  kubectl get nodes -o wide
  ```

  > **Salida esperada:** `cka-control` utiliza `10.10.10.10` y `cka-worker1` utiliza `10.10.10.11`; ambos reportan containerd como runtime.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta las columnas de labels más comunes sin modificar ningún nodo.

  ```bash
  kubectl get nodes --show-labels
  ```

  > **Salida esperada:** Se observan labels del sistema, arquitectura, hostname y rol del control plane.
  {: .lab-note .output .compact}

### Tarea 2.2. Interpretar el estado detallado de cka-worker1

Usarás `kubectl describe` para localizar las secciones que un administrador consulta al diagnosticar capacidad, presión de recursos o problemas del nodo.

- {% include step_label.html %} Obtén la descripción completa de `cka-worker1`.

  ```bash
  kubectl describe node cka-worker1
  ```

  > **Nota:** No es necesario memorizar toda la salida. Localiza las secciones `Labels`, `Taints`, `Conditions`, `Capacity`, `Allocatable`, `System Info`, `Allocated resources` y `Events`.
  {: .lab-note .info .compact}

- {% include step_label.html %} Extrae únicamente las condiciones del nodo para facilitar su lectura.

  ```bash
  kubectl get node cka-worker1 \
    -o jsonpath='{range .status.conditions[*]}{.type}{"="}{.status}{"\n"}{end}'
  ```

  > **Salida esperada:** `Ready=True` y las condiciones de presión relevantes, como `MemoryPressure`, `DiskPressure` y `PIDPressure`, deben aparecer en `False` en un nodo sano.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta la capacidad total del nodo.

  ```bash
  kubectl get node cka-worker1 \
    -o jsonpath='{.status.capacity}{"\n"}'
  ```

  > **Salida esperada:** Se muestran recursos como `cpu`, `memory`, `pods` y almacenamiento efímero disponibles físicamente en el nodo.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta los recursos asignables a Pods después de las reservas del sistema.

  ```bash
  kubectl get node cka-worker1 \
    -o jsonpath='{.status.allocatable}{"\n"}'
  ```

  > **Salida esperada:** Se muestran los valores `Allocatable`, que pueden ser menores a `Capacity` y representan lo que Kubernetes puede asignar a las cargas.
  {: .lab-note .output .compact}

### Tarea 2.3. Comparar control plane y worker

Compararás características administrativas de ambos tipos de nodo para reconocer qué elementos distinguen al control plane de un worker.

- {% include step_label.html %} Revisa los labels asociados específicamente al rol del control plane.

  ```bash
  kubectl get node cka-control --show-labels
  ```

  > **Salida esperada:** Se identifica el label `node-role.kubernetes.io/control-plane` entre los labels de `cka-control`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta los taints configurados en el control plane.

  ```bash
  kubectl get node cka-control \
    -o jsonpath='{.spec.taints}{"\n"}'
  ```

  > **Salida esperada:** Debe observarse el taint administrativo que evita programar cargas normales en el control plane, salvo que exista una toleration compatible.
  {: .lab-note .output .compact}

- {% include step_label.html %} Compara los taints del worker.

  ```bash
  kubectl get node cka-worker1 \
    -o jsonpath='{.spec.taints}{"\n"}'
  ```

  > **Salida esperada:** En el estado base del laboratorio, `cka-worker1` no debe presentar el taint de `control-plane`.
  {: .lab-note .output .compact}

{% capture r2 %}{{ results[1] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r2 %}

{% include support-prompt.html task="tarea2" %}

---

## 🧭 Tarea 3. Inspección del control plane — 12 min

Relacionarás los componentes críticos del control plane con los Pods visibles desde Kubernetes, los manifiestos estáticos almacenados en el nodo y los contenedores gestionados por containerd. También validarás la salud del API Server.

### Tarea 3.1. Identificar los componentes del control plane

Localizarás los componentes del control plane dentro de `kube-system` y verificarás en qué nodo se ejecutan.

- {% include step_label.html %} Lista los Pods del namespace `kube-system` con información de nodo e IP.

  ```bash
  kubectl get pods -n kube-system -o wide
  ```

  > **Salida esperada:** Se observan `kube-apiserver-cka-control`, `kube-controller-manager-cka-control`, `kube-scheduler-cka-control` y `etcd-cka-control`, además de CoreDNS, kube-proxy y Calico.
  {: .lab-note .output .compact}

- {% include step_label.html %} Filtra los Pods que representan los cuatro componentes principales del control plane.

  ```bash
  kubectl get pods -n kube-system \
    -l tier=control-plane -o wide
  ```

  > **Salida esperada:** Se muestran los static Pods del control plane que utilizan el label `tier=control-plane`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba el estado individual de etcd mediante su label de componente.

  ```bash
  kubectl get pod -n kube-system \
    -l component=etcd -o wide
  ```

  > **Salida esperada:** `etcd-cka-control` aparece `1/1 Running` sobre `cka-control`.
  {: .lab-note .output .compact}

### Tarea 3.2. Relacionar static Pods con sus manifiestos

Inspeccionarás la ubicación que kubeadm utiliza para los manifiestos estáticos y comprobarás que cada archivo corresponde a un componente del control plane.

- {% include step_label.html %} Lista los manifiestos estáticos presentes en el control plane.

  ```bash
  sudo ls -l /etc/kubernetes/manifests/
  ```

  > **Salida esperada:** Existen `etcd.yaml`, `kube-apiserver.yaml`, `kube-controller-manager.yaml` y `kube-scheduler.yaml`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Identifica la imagen utilizada por el kube-apiserver sin editar el manifiesto.

  ```bash
  sudo grep -n 'image:' \
    /etc/kubernetes/manifests/kube-apiserver.yaml
  ```

  > **Salida esperada:** Se muestra la imagen del `kube-apiserver` correspondiente a la versión Kubernetes del clúster.
  {: .lab-note .output .compact}

- {% include step_label.html %} Identifica el directorio de datos configurado para etcd.

  ```bash
  sudo grep -n -- '--data-dir' \
    /etc/kubernetes/manifests/etcd.yaml
  ```

  > **Salida esperada:** El manifiesto muestra el parámetro `--data-dir` utilizado por etcd para almacenar sus datos.
  {: .lab-note .output .compact}

### Tarea 3.3. Relacionar Kubernetes con el container runtime

Usarás `crictl` para observar los contenedores que containerd mantiene en ejecución y compararlos con los componentes ya vistos mediante kubectl.

- {% include step_label.html %} Lista los contenedores administrados por el runtime en `cka-control`.

  ```bash
  sudo crictl ps
  ```

  > **Salida esperada:** Aparecen contenedores como `kube-apiserver`, `etcd`, `kube-scheduler`, `kube-controller-manager`, `coredns`, `kube-proxy` y componentes de Calico.
  {: .lab-note .output .compact}

- {% include step_label.html %} Localiza específicamente el contenedor del API Server.

  ```bash
  sudo crictl ps | grep kube-apiserver
  ```

  > **Salida esperada:** Se muestra un contenedor `Running` asociado al Pod `kube-apiserver-cka-control`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Localiza específicamente el contenedor de etcd.

  ```bash
  sudo crictl ps | grep etcd
  ```

  > **Salida esperada:** Se muestra un contenedor `Running` asociado al Pod `etcd-cka-control`.
  {: .lab-note .output .compact}

### Tarea 3.4. Validar la salud del API Server

Consultarás directamente los endpoints de salud expuestos por el API Server para distinguir una simple conexión exitosa de una validación interna de readiness.

- {% include step_label.html %} Consulta el endpoint resumido de readiness.

  ```bash
  kubectl get --raw='/readyz'
  ```

  > **Salida esperada:** El API Server responde `ok`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta las verificaciones detalladas de readiness.

  ```bash
  kubectl get --raw='/readyz?verbose'
  ```

  > **Salida esperada:** Las verificaciones internas aparecen como exitosas y la respuesta final confirma que el API Server está listo.
  {: .lab-note .output .compact}

{% capture r3 %}{{ results[2] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r3 %}

{% include support-prompt.html task="tarea3" %}

---

## ⚙️ Tarea 4. Inspección del worker y del runtime — 10 min

Cambiarás de perspectiva y entrarás directamente a `cka-worker1` para revisar kubelet, containerd y los directorios administrativos del nodo. El objetivo es relacionar lo que Kubernetes muestra desde el control plane con los servicios que realmente operan en el worker.

### Tarea 4.1. Acceder al worker y comprobar kubelet

Abrirás una sesión independiente en el worker y comprobarás que kubelet está activo y registrando actividad normal.

- {% include step_label.html %} Sal de la sesión del control plane.

  ```bash
  exit
  ```

  > **Salida esperada:** Regresas a la terminal de Windows desde la que iniciaste la conexión SSH.
  {: .lab-note .output .compact}

- {% include step_label.html %} Conéctate a `cka-worker1` mediante SSH.

  ```bash
  ssh worker1@192.168.10.101
  ```

  > **Salida esperada:** La sesión inicia en `cka-worker1` con el usuario asignado al worker.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba el estado del servicio kubelet.

  ```bash
  systemctl status kubelet --no-pager
  ```

  > **Salida esperada:** El servicio aparece `active (running)`.
  {: .lab-note .output .compact}

### Tarea 4.2. Revisar logs, containerd y CRI

Validarás el servicio del runtime y usarás `crictl` para identificar Pods y contenedores ejecutándose directamente en el worker.

- {% include step_label.html %} Consulta los mensajes recientes de kubelet.

  ```bash
  sudo journalctl -u kubelet -n 20 --no-pager
  ```

  > **Salida esperada:** Se muestran eventos recientes del kubelet sin un patrón continuo de errores que impida su operación.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba que containerd está activo.

  ```bash
  systemctl status containerd --no-pager
  ```

  > **Salida esperada:** `containerd.service` aparece `active (running)`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Lista los contenedores que el runtime mantiene activos en el worker.

  ```bash
  sudo crictl ps
  ```

  > **Salida esperada:** Se observan contenedores de infraestructura como `calico-node` y `kube-proxy`, además de cualquier workload actualmente programado en el nodo.
  {: .lab-note .output .compact}

- {% include step_label.html %} Lista los Pod sandboxes conocidos por el runtime.

  ```bash
  sudo crictl pods
  ```

  > **Salida esperada:** Se muestran los sandboxes de Pods activos en `cka-worker1`, incluyendo componentes de `kube-system` ejecutados en ese nodo.
  {: .lab-note .output .compact}

### Tarea 4.3. Inspeccionar archivos administrativos del worker

Compararás los archivos presentes en un worker con los del control plane para identificar qué configuración pertenece a kubelet y qué elementos sólo existen en el nodo de control.

- {% include step_label.html %} Lista el contenido del directorio `/etc/kubernetes` del worker.

  ```bash
  sudo ls -l /etc/kubernetes/
  ```

  > **Salida esperada:** Se observan archivos asociados al kubelet, pero no los cuatro manifiestos estáticos del control plane.
  {: .lab-note .output .compact}

- {% include step_label.html %} Confirma que el directorio de manifiestos del control plane no contiene componentes estáticos en este worker.

  ```bash
  sudo ls -l /etc/kubernetes/manifests/ 2>/dev/null || true
  ```

  > **Salida esperada:** El directorio puede existir vacío o no contener `kube-apiserver.yaml`, `etcd.yaml`, `kube-controller-manager.yaml` ni `kube-scheduler.yaml`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa los archivos principales administrados por kubelet.

  ```bash
  sudo ls -l /var/lib/kubelet/
  ```

  > **Salida esperada:** Se identifican archivos y directorios como `config.yaml`, `pki`, `pods` y otros elementos utilizados por kubelet.
  {: .lab-note .output .compact}

{% capture r4 %}{{ results[3] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r4 %}

{% include support-prompt.html task="tarea4" %}

---

## 🌐 Tarea 5. Validación de networking, DNS, storage y salud general — 11 min

Regresarás al control plane para comprobar los servicios de plataforma que sostienen la operación del clúster. Revisarás CNI, CoreDNS, kube-proxy, StorageClass, eventos y salud general sin crear ni modificar recursos persistentes.

### Tarea 5.1. Validar el CNI y kube-proxy

Comprobarás que los componentes responsables de la red de Pods y del procesamiento de Services se encuentran desplegados en los nodos esperados.

- {% include step_label.html %} Regresa al control plane desde Windows.

  ```bash
  exit
  ```
  ```bash
  ssh control@192.168.10.100
  ```

  > **Salida esperada:** El prompt vuelve a corresponder a `control@cka-control`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba el DaemonSet de Calico y sus Pods.

  ```bash
  kubectl get daemonset calico-node -n kube-system
  ```
  ```bash
  kubectl get pods -n kube-system -l k8s-app=calico-node -o wide
  ```

  > **Salida esperada:** El DaemonSet reporta dos instancias disponibles y los Pods `calico-node` aparecen `1/1 Running` sobre `cka-control` y `cka-worker1`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba el DaemonSet de kube-proxy.

  ```bash
  kubectl get daemonset kube-proxy -n kube-system
  ```

  > **Salida esperada:** Los valores `DESIRED`, `CURRENT`, `READY` y `AVAILABLE` son coherentes con los nodos actualmente unidos al clúster.
  {: .lab-note .output .compact}

### Tarea 5.2. Validar CoreDNS

Verificarás que Kubernetes dispone de un servicio DNS interno y que las réplicas de CoreDNS se encuentran disponibles.

- {% include step_label.html %} Revisa el Deployment de CoreDNS.

  ```bash
  kubectl get deployment coredns -n kube-system
  ```

  > **Salida esperada:** Las réplicas configuradas aparecen disponibles y listas.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta el Service utilizado por los Pods para resolución DNS interna.

  ```bash
  kubectl get service kube-dns -n kube-system
  ```

  > **Salida esperada:** Se muestra el Service `kube-dns` con una `CLUSTER-IP`; en el entorno base se utiliza `10.96.0.10`.
  {: .lab-note .output .compact}

### Tarea 5.3. Inspeccionar almacenamiento disponible

Identificarás la StorageClass predeterminada y comprobarás si existen volúmenes persistentes o claims antes de realizar prácticas específicas de storage.

- {% include step_label.html %} Lista las StorageClasses configuradas.

  ```bash
  kubectl get storageclass
  ```

  > **Salida esperada:** `local-path` aparece como StorageClass predeterminada.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa los PV y PVC existentes sin crear recursos nuevos.

  ```bash
  kubectl get pv
  ```
  ```bash
  kubectl get pvc -A
  ```

  > **Salida esperada:** Puede no existir ningún PV o PVC todavía; lo importante es que las consultas se completen sin errores.
  {: .lab-note .output .compact}

### Tarea 5.4. Confirmar la salud global del clúster

Cerrarás la práctica con una revisión de nodos, Pods, eventos recientes y readiness del API Server para establecer una línea base operativa.

- {% include step_label.html %} Revisa de forma consolidada nodos, Pods del sistema y eventos recientes.

  ```bash
  kubectl get nodes -o wide
  ```
  ```bash
  kubectl get pods -n kube-system -o wide
  ```
  ```bash
  kubectl get events -A --sort-by=.lastTimestamp | tail -n 20
  ```

  > **Salida esperada:** `cka-control` y `cka-worker1` permanecen `Ready`; los componentes críticos están `Running` y no existe un error activo que comprometa la operación del clúster.
  {: .lab-note .output .compact}

- {% include step_label.html %} Realiza la verificación final del API Server.

  ```bash
  kubectl get --raw='/readyz'
  ```

  > **Salida esperada:** El API Server responde `ok`.
  {: .lab-note .output .compact}

{% capture r5 %}{{ results[4] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r5 %}

{% include support-prompt.html task="tarea5" %}