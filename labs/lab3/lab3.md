---
layout: lab
title: "Práctica 3: Crear y validar un clúster con kubeadm y preparar nodos"
permalink: /lab3/lab3/
images_base: /labs/lab3/img
duration: "60 minutos"
objective:
  - Incorporar un nuevo worker a un clúster Kubernetes administrado con kubeadm, comprendiendo el proceso de bootstrap del kubelet, la relación con containerd, el despliegue automático de componentes por nodo y la validación final del estado operativo.
prerequisites:
  - Haber completado las Prácticas 1 y 2 o dominar la inspección básica y el mantenimiento administrativo de nodos.
  - Disponer de cka-control y cka-worker1 en estado Ready.
  - Tener cka-worker2 preparado con Ubuntu, containerd, kubeadm, kubelet, kubectl y crictl, pero todavía sin unir al clúster.
  - Mantener deshabilitado swap y habilitados los parámetros de kernel requeridos para Kubernetes.
  - Contar con conectividad entre cka-control y cka-worker2 mediante la red privada 10.10.10.0/24.
introduction:
  - En esta práctica incorporarás cka-worker2 al clúster mediante kubeadm. Antes del join validarás el estado del nodo y revisarás qué archivos aún no existen; después generarás un token de bootstrap, ejecutarás kubeadm join y observarás cómo kubelet obtiene su configuración, se registra ante el API Server y permite que Calico y kube-proxy se desplieguen automáticamente en el nuevo worker.
slug: lab3
lab_number: 3
final_result: >
  Al finalizar, cka-worker2 estará unido correctamente al clúster y aparecerá en estado Ready junto con cka-control y cka-worker1. Habrás validado el bootstrap de kubelet, la conectividad con containerd, el despliegue de Calico y kube-proxy, la asignación de Pods al nuevo worker y la salud general del clúster de tres nodos.
notes:
  - Esta práctica modifica de forma permanente el estado base del curso al unir cka-worker2; no ejecutes kubeadm reset al finalizar.
  - El comando kubeadm join contiene un token temporal y un hash de descubrimiento; genera el comando durante la práctica en lugar de reutilizar uno antiguo.
  - Algunos mensajes de kubelet antes del join son esperados porque todavía no existen los archivos que kubeadm genera durante el bootstrap.
references:
  - text: Kubernetes - Creating a cluster with kubeadm
    url: https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/create-cluster-kubeadm/
  - text: Kubernetes - kubeadm join
    url: https://kubernetes.io/docs/reference/setup-tools/kubeadm/kubeadm-join/
prev: /lab2/lab2/
next: /lab4/lab4/
---

---

<!-- Aquí comienzan las instrucciones paso a paso de la práctica -->

## 🔎 Tarea 1. Validar el estado previo del entorno — 10 min

Comprobarás que el clúster actual está sano y que cka-worker2 cumple los requisitos técnicos necesarios para incorporarse. También observarás qué elementos aún no existen en el worker antes de ejecutar kubeadm join.

### Tarea 1.1. Confirmar el estado actual del clúster

Establecerás una línea base desde cka-control para confirmar que sólo existen dos nodos unidos y que el API Server está disponible antes de iniciar el bootstrap del nuevo worker.

- {% include step_label.html %} Conéctate a `cka-control`, desde donde generarás y validarás la información administrativa del clúster.

  > **Nota:** Antes de realizar cambios con kubeadm, confirma siempre desde qué nodo administras el clúster y qué contexto utiliza kubectl.
  {: .lab-note .info .compact}

  ```bash
  ssh control@192.168.10.100
  ```

  > **Salida esperada:** Se abre una sesión SSH en `cka-control`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Verifica que actualmente sólo `cka-control` y `cka-worker1` forman parte del clúster.

  ```bash
  kubectl get nodes -o wide
  ```

  > **Salida esperada:** Se muestran dos nodos en estado `Ready`; `cka-worker2` todavía no aparece.
  {: .lab-note .output .compact}

- {% include step_label.html %} Confirma que el API Server está listo antes de iniciar el proceso de incorporación.

  ```bash
  kubectl get --raw='/readyz'
  ```

  > **Salida esperada:** El API Server responde `ok`.
  {: .lab-note .output .compact}

### Tarea 1.2. Validar requisitos del sistema en cka-worker2

Comprobarás que el worker tiene runtime, binarios, red y configuración de kernel adecuados para kubeadm antes de ejecutar el join.

- {% include step_label.html %} Abre una segunda sesión SSH hacia `cka-worker2`.

  ```bash
  ssh worker2@192.168.10.102
  ```

  > **Salida esperada:** La sesión se abre correctamente en `cka-worker2`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Verifica que swap está deshabilitado y que los parámetros principales de red están activos.

  > **Importante:** kubelet requiere una configuración compatible con la gestión de memoria y networking del clúster. Si estos valores no son correctos, el join puede completarse parcialmente y dejar el nodo sin funcionar correctamente.
  {: .lab-note .important .compact}

  ```bash
  swapon --show
  ```

  ```bash
  sysctl net.ipv4.ip_forward net.bridge.bridge-nf-call-iptables
  ```

  > **Salida esperada:** `swapon --show` no devuelve dispositivos activos y ambos parámetros de kernel muestran valor `1`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba que containerd y las herramientas Kubernetes están instaladas con las versiones esperadas.

  ```bash
  systemctl is-active containerd
  ```

  ```bash
  kubeadm version -o short
  ```

  ```bash
  kubelet --version
  ```

  > **Salida esperada:** containerd está `active` y kubeadm/kubelet corresponden a Kubernetes `v1.35.8`.
  {: .lab-note .output .compact}

### Tarea 1.3. Observar el estado pre-join de kubelet

Identificarás por qué kubelet todavía no puede trabajar como miembro del clúster y qué archivos serán creados por kubeadm durante el bootstrap.

- {% include step_label.html %} Consulta el estado actual del servicio kubelet antes del join.

  > **Nota:** En un worker preparado pero aún no unido, kubelet puede aparecer inactivo o reiniciándose porque todavía no dispone de la configuración generada por kubeadm.
  {: .lab-note .info .compact}

  ```bash
  systemctl status kubelet --no-pager
  ```

  > **Salida esperada:** kubelet puede mostrar estado `inactive`, `failed` o intentos de reinicio; este comportamiento es esperado antes de `kubeadm join`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba que aún no existe el kubeconfig que identifica al kubelet ante el API Server.

  ```bash
  sudo test -f /etc/kubernetes/kubelet.conf && echo "kubelet.conf existe" || echo "kubelet.conf aún no existe"
  ```

  > **Salida esperada:** Se muestra `kubelet.conf aún no existe`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa los mensajes recientes de kubelet para relacionar el estado del servicio con la falta de configuración.

  ```bash
  sudo journalctl -u kubelet -n 15 --no-pager
  ```

  > **Salida esperada:** Pueden aparecer referencias a archivos de configuración ausentes, como `/var/lib/kubelet/config.yaml`; esto cambiará después del join.
  {: .lab-note .output .compact}

{% assign results = site.data.task-results[page.slug].results %}
{% capture r1 %}{{ results[0] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r1 %}

{% include support-prompt.html task="tarea1" %}

---

## 🔐 Tarea 2. Generar y revisar el comando kubeadm join — 10 min

Generarás desde el control plane un token de bootstrap válido y analizarás los elementos principales del comando antes de utilizarlo en cka-worker2.

### Tarea 2.1. Revisar los tokens de bootstrap

Consultarás los tokens existentes para entender su función y evitar depender de credenciales expiradas o creadas para otro momento del curso.

- {% include step_label.html %} Regresa a la terminal de `cka-control`.

  ```bash
  hostname
  ```

  > **Salida esperada:** Se muestra `cka-control`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta los tokens de bootstrap que existen actualmente.

  ```bash
  sudo kubeadm token list
  ```

  > **Nota:** Los tokens de kubeadm son credenciales temporales utilizadas durante el descubrimiento y bootstrap inicial del nodo; no sustituyen las credenciales permanentes del kubelet.
  {: .lab-note .info .compact}

  > **Salida esperada:** Puede mostrarse uno o más tokens o una lista vacía si los tokens anteriores expiraron.
  {: .lab-note .output .compact}

- {% include step_label.html %} Confirma el endpoint del API Server que será utilizado por el nuevo worker.

  ```bash
  kubectl cluster-info
  ```

  > **Salida esperada:** El control plane de Kubernetes se anuncia mediante el endpoint configurado para el clúster.
  {: .lab-note .output .compact}

### Tarea 2.2. Crear un comando de unión nuevo

Generarás un token nuevo junto con el hash de descubrimiento requerido para validar la identidad del control plane durante el join.

- {% include step_label.html %} Genera un comando `kubeadm join` nuevo y listo para utilizar.

  > **Importante:** No reutilices comandos antiguos guardados en notas. El token puede haber expirado y el endpoint debe corresponder al clúster actual.
  {: .lab-note .important .compact}

  ```bash
  sudo kubeadm token create --print-join-command
  ```

  > **Salida esperada:** Se muestra un comando similar a `kubeadm join 10.10.10.10:6443 --token ... --discovery-token-ca-cert-hash sha256:...`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Identifica en la salida el endpoint, token y hash de descubrimiento antes de copiar el comando.

  > **Nota:** El `--discovery-token-ca-cert-hash` permite que el worker verifique la CA del clúster y evita confiar ciegamente en cualquier API Server que responda en la dirección indicada.
  {: .lab-note .info .compact}

  ```bash
  sudo kubeadm token list
  ```

  > **Salida esperada:** El token recién creado aparece como válido y con un tiempo de expiración definido.
  {: .lab-note .output .compact}

- {% include step_label.html %} Copia temporalmente el comando completo que generó kubeadm para utilizarlo en `cka-worker2`.

  > **Advertencia:** El token es una credencial temporal. No publiques ni reutilices el comando fuera de este entorno de laboratorio.
  {: .lab-note .warning .compact}

  > **Salida esperada:** Conservas el comando completo sin alterar el endpoint, token ni hash.
  {: .lab-note .output .compact}

### Tarea 2.3. Validar conectividad antes del join

Comprobarás desde cka-worker2 que el endpoint privado del API Server es alcanzable antes de iniciar el bootstrap.

- {% include step_label.html %} Vuelve a la sesión de `cka-worker2` y confirma su hostname.

  ```bash
  hostname
  ```

  > **Salida esperada:** Se muestra `cka-worker2`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba conectividad IP hacia la dirección privada del control plane.

  ```bash
  ping -c 3 10.10.10.10
  ```

  > **Salida esperada:** Se reciben respuestas desde `10.10.10.10` sin pérdida significativa.
  {: .lab-note .output .compact}

- {% include step_label.html %} Verifica que el puerto TCP del API Server está accesible desde el worker.

  > **Nota:** El join depende de alcanzar el API Server por TCP/6443. Validarlo antes ayuda a separar problemas de red de problemas propios de kubeadm.
  {: .lab-note .info .compact}

  ```bash
  timeout 3 bash -c '</dev/tcp/10.10.10.10/6443' && echo "API Server accesible" || echo "No accesible"
  ```

  > **Salida esperada:** Se muestra `API Server accesible`.
  {: .lab-note .output .compact}

{% capture r2 %}{{ results[1] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r2 %}

{% include support-prompt.html task="tarea2" %}

---

## 🚀 Tarea 3. Unir cka-worker2 al clúster — 16 min

Ejecutarás kubeadm join en el worker y observarás cómo se generan los archivos de configuración necesarios para que kubelet se registre en el clúster.

### Tarea 3.1. Ejecutar kubeadm join

Utilizarás el comando recién generado para iniciar el proceso de descubrimiento, bootstrap TLS y registro del nuevo nodo.

- {% include step_label.html %} Confirma una última vez que estás trabajando en `cka-worker2`.

  ```bash
  hostname
  ```

  > **Salida esperada:** Se muestra `cka-worker2`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Verifica que el nodo aún no contiene un kubelet.conf generado por una unión anterior.

  ```bash
  sudo test -f /etc/kubernetes/kubelet.conf && echo "Revisar estado previo" || echo "Nodo preparado para join"
  ```

  > **Salida esperada:** Se muestra `Nodo preparado para join`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Ejecuta con `sudo` el comando completo `kubeadm join` generado desde cka-control.

  > **Importante:** Sustituye el ejemplo por el comando real obtenido en la Tarea 2. No escribas manualmente un token o hash ficticio.
  {: .lab-note .important .compact}

  ```bash
  sudo kubeadm join 10.10.10.10:6443 --token <TOKEN_REAL> --discovery-token-ca-cert-hash sha256:<HASH_REAL>
  ```

  > **Salida esperada:** kubeadm completa las verificaciones previas, realiza el bootstrap y muestra un mensaje indicando que el nodo se unió correctamente al clúster.
  {: .lab-note .output .compact}

- {% include step_label.html %} Conserva visible el mensaje final del join e identifica la confirmación de que kubelet inició el proceso de registro.

  > **Nota:** kubeadm prepara la configuración local, pero kubelet es quien mantiene posteriormente la relación continua entre el nodo y el control plane.
  {: .lab-note .info .compact}

  > **Salida esperada:** El mensaje final confirma que el nodo se incorporó y que puedes ejecutar `kubectl get nodes` desde el control plane.
  {: .lab-note .output .compact}

### Tarea 3.2. Revisar los archivos creados por kubeadm

Compararás el estado del worker antes y después del join para identificar los archivos que habilitan el funcionamiento del kubelet.

- {% include step_label.html %} Comprueba que ahora existe `/etc/kubernetes/kubelet.conf`.

  ```bash
  sudo ls -l /etc/kubernetes/kubelet.conf
  ```

  > **Salida esperada:** El archivo existe y fue generado durante el proceso de join.
  {: .lab-note .output .compact}

- {% include step_label.html %} Verifica que kubeadm creó la configuración principal utilizada por kubelet.

  ```bash
  sudo ls -l /var/lib/kubelet/config.yaml
  ```

  > **Salida esperada:** El archivo `/var/lib/kubelet/config.yaml` existe.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa los argumentos dinámicos con los que kubeadm inicia kubelet.

  ```bash
  sudo cat /var/lib/kubelet/kubeadm-flags.env
  ```

  > **Nota:** Este archivo permite observar parámetros que kubeadm entrega a kubelet, incluida la integración con el runtime mediante CRI.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se muestra la variable `KUBELET_KUBEADM_ARGS` con los argumentos generados para el nodo.
  {: .lab-note .output .compact}

- {% include step_label.html %} Confirma que el servicio kubelet ahora permanece activo después de recibir su configuración.

  ```bash
  systemctl is-active kubelet
  ```

  > **Salida esperada:** El resultado es `active`.
  {: .lab-note .output .compact}

### Tarea 3.3. Validar el registro desde el control plane

Observarás cómo el nuevo objeto Node aparece en Kubernetes y distinguirás el estado de registro del estado de disponibilidad completa del nodo.

- {% include step_label.html %} Regresa a `cka-control` y lista los nodos inmediatamente después del join.

  ```bash
  kubectl get nodes -o wide
  ```

  > **Nota:** Durante los primeros segundos `cka-worker2` puede aparecer `NotReady` mientras el CNI y otros componentes por nodo se inicializan. Esto no implica que el join haya fallado.
  {: .lab-note .info .compact}

  > **Salida esperada:** `cka-worker2` aparece como nuevo objeto Node, inicialmente `NotReady` o ya `Ready`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Inspecciona las condiciones del nuevo nodo para identificar qué información reporta kubelet.

  ```bash
  kubectl describe node cka-worker2 | sed -n '/Conditions:/,/Addresses:/p'
  ```

  > **Salida esperada:** Se muestran condiciones como `MemoryPressure`, `DiskPressure`, `PIDPressure` y `Ready`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Espera hasta que Kubernetes marque el nodo como Ready.

  ```bash
  kubectl wait --for=condition=Ready node/cka-worker2 --timeout=180s
  ```

  > **Salida esperada:** Se confirma que `node/cka-worker2` cumple la condición `Ready`.
  {: .lab-note .output .compact}

### Tarea 3.4. Confirmar la identidad y versión del nuevo nodo

Validarás que Kubernetes registró correctamente hostname, IP privada, versión y runtime del worker.

- {% include step_label.html %} Consulta la vista ampliada de los tres nodos.

  ```bash
  kubectl get nodes -o wide
  ```

  > **Salida esperada:** Se muestran `cka-control`, `cka-worker1` y `cka-worker2` en estado `Ready`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Obtén la IP interna registrada para `cka-worker2`.

  ```bash
  kubectl get node cka-worker2 -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}'
  ```

  > **Salida esperada:** Se muestra `10.10.10.12`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Confirma la versión de kubelet y el runtime reportados por el nodo.

  ```bash
  kubectl get node cka-worker2 -o jsonpath='{.status.nodeInfo.kubeletVersion}{" | "}{.status.nodeInfo.containerRuntimeVersion}{"\n"}'
  ```

  > **Salida esperada:** Se muestra kubelet `v1.35.8` y `containerd://2.2.2`.
  {: .lab-note .output .compact}

{% capture r3 %}{{ results[2] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r3 %}

{% include support-prompt.html task="tarea3" %}

---

## ⚙️ Tarea 4. Validar kubelet, runtime y CNI en el nuevo nodo — 12 min

Comprobarás desde cka-worker2 y desde el control plane que kubelet, containerd, Calico y kube-proxy funcionan como partes integradas del nuevo worker.

### Tarea 4.1. Verificar kubelet después del bootstrap

Confirmarás que el servicio mantiene comunicación estable con el control plane y que los errores previos por archivos ausentes ya no se presentan.

- {% include step_label.html %} En `cka-worker2`, verifica nuevamente que kubelet está activo.

  ```bash
  systemctl status kubelet --no-pager
  ```

  > **Salida esperada:** El servicio aparece `active (running)`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa los mensajes recientes del servicio después del join.

  ```bash
  sudo journalctl -u kubelet -n 20 --no-pager
  ```

  > **Nota:** Pueden existir mensajes informativos transitorios durante el arranque, pero ya no deberían repetirse los errores causados por la ausencia de `/var/lib/kubelet/config.yaml`.
  {: .lab-note .info .compact}

  > **Salida esperada:** kubelet opera con su configuración cargada y sin un ciclo continuo de reinicios.
  {: .lab-note .output .compact}

- {% include step_label.html %} Confirma que el kubeconfig de kubelet hace referencia al clúster y a las credenciales generadas durante bootstrap.

  ```bash
  sudo grep -E 'server:|client-certificate:|client-key:' /etc/kubernetes/kubelet.conf
  ```

  > **Salida esperada:** Se observa el endpoint del API Server y referencias a credenciales de cliente.
  {: .lab-note .output .compact}

### Tarea 4.2. Verificar containerd y CRI

Comprobarás que kubelet puede utilizar containerd y que los contenedores de infraestructura del nuevo worker aparecen mediante crictl.

- {% include step_label.html %} Confirma que containerd permanece activo después de unir el nodo.

  ```bash
  systemctl is-active containerd
  ```

  > **Salida esperada:** El resultado es `active`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba que crictl utiliza el endpoint configurado de containerd sin advertencias de endpoints por defecto.

  > **Nota:** `/etc/crictl.yaml` ya fue preparado en el entorno base para apuntar directamente a `unix:///run/containerd/containerd.sock`.
  {: .lab-note .info .compact}

  ```bash
  sudo crictl ps
  ```

  > **Salida esperada:** Se muestran contenedores administrados por el runtime y no aparece la advertencia de endpoints CRI predeterminados.
  {: .lab-note .output .compact}

- {% include step_label.html %} Identifica los sandboxes de Pods que containerd mantiene en el nuevo worker.

  ```bash
  sudo crictl pods
  ```

  > **Salida esperada:** Aparecen sandboxes asociados a componentes como `calico-node` y `kube-proxy`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control` verifica que kubelet reporta a Kubernetes el mismo runtime que acabas de consultar localmente.

  ```bash
  kubectl get node cka-worker2 -o jsonpath='{.status.nodeInfo.containerRuntimeVersion}{"\n"}'
  ```

  > **Salida esperada:** Kubernetes reporta `containerd://2.2.2`.
  {: .lab-note .output .compact}

### Tarea 4.3. Validar CNI y kube-proxy

Comprobarás que los DaemonSets de infraestructura extendieron automáticamente su presencia al nuevo nodo.

- {% include step_label.html %} Desde `cka-control`, consulta los Pods de Calico y verifica su distribución.

  ```bash
  kubectl get pods -n kube-system -l k8s-app=calico-node -o wide
  ```

  > **Nota:** Al ser un DaemonSet, `calico-node` crea automáticamente una instancia en cada nodo Linux que coincide con su selector.
  {: .lab-note .info .compact}

  > **Salida esperada:** Existen tres Pods de `calico-node`, incluido uno `Running` en `cka-worker2`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba que kube-proxy también tiene una instancia en el nuevo worker.

  ```bash
  kubectl get pods -n kube-system -l k8s-app=kube-proxy -o wide
  ```

  > **Salida esperada:** Se observa un Pod de `kube-proxy` `Running` en cada uno de los tres nodos.
  {: .lab-note .output .compact}

- {% include step_label.html %} Verifica que ambos DaemonSets alcanzaron el número esperado de instancias listas.

  ```bash
  kubectl get daemonset calico-node kube-proxy -n kube-system
  ```

  > **Salida esperada:** `DESIRED`, `CURRENT`, `READY` y `AVAILABLE` convergen en `3` para ambos DaemonSets.
  {: .lab-note .output .compact}

{% capture r4 %}{{ results[3] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r4 %}

{% include support-prompt.html task="tarea4" %}

---

## ✅ Tarea 5. Verificar la integración completa del nodo — 12 min

Realizarás una validación funcional final para demostrar que el nuevo worker puede recibir cargas, obtener networking del CNI y resolver servicios internos mediante CoreDNS.

### Tarea 5.1. Programar una carga específicamente en cka-worker2

Crearás un Pod de validación dirigido al nuevo nodo para comprobar que scheduler, kubelet y runtime trabajan de forma coordinada.

- {% include step_label.html %} Desde `cka-control` crea un Pod temporal con `nodeSelector` dirigido a `cka-worker2`.

  > **Nota:** El selector se utiliza sólo para esta validación. Permite demostrar explícitamente que el nuevo worker acepta una carga de usuario.
  {: .lab-note .info .compact}

  ```bash
  cat > lab3-node-test.yaml <<'EOF'
  apiVersion: v1
  kind: Pod
  metadata:
    name: worker2-test
  spec:
    nodeSelector:
      kubernetes.io/hostname: cka-worker2
    containers:
      - name: test
        image: busybox:1.36
        command: ["sh", "-c", "sleep 3600"]
  EOF
  ```

  > **Salida esperada:** El archivo `lab3-node-test.yaml` queda creado.
  {: .lab-note .output .compact}

- {% include step_label.html %} Crea el Pod y espera a que alcance la condición Ready.

  ```bash
  kubectl apply -f lab3-node-test.yaml
  ```

  ```bash
  kubectl wait --for=condition=Ready pod/worker2-test --timeout=120s
  ```

  > **Salida esperada:** Kubernetes confirma que `worker2-test` está Ready.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba que el Pod fue realmente programado en cka-worker2 y recibió una IP del CNI.

  ```bash
  kubectl get pod worker2-test -o wide
  ```

  > **Salida esperada:** La columna `NODE` muestra `cka-worker2` y el Pod tiene una dirección IP asignada por Calico.
  {: .lab-note .output .compact}

### Tarea 5.2. Validar DNS y conectividad interna

Utilizarás el Pod recién creado para comprobar que CoreDNS y la red del clúster funcionan desde el nuevo worker.

- {% include step_label.html %} Resuelve el nombre DNS del servicio Kubernetes desde el Pod ubicado en cka-worker2.

  ```bash
  kubectl exec worker2-test -- nslookup kubernetes.default.svc.cluster.local
  ```

  > **Nota:** Esta prueba recorre varias capas a la vez: Pod, CNI, servicio kube-dns/CoreDNS y resolución del Service `kubernetes`.
  {: .lab-note .info .compact}

  > **Salida esperada:** La consulta devuelve la dirección del servicio `kubernetes.default`, normalmente `10.96.0.1`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba que CoreDNS permanece disponible después de incorporar el nuevo nodo.

  ```bash
  kubectl get deployment coredns -n kube-system
  ```

  > **Salida esperada:** El Deployment de CoreDNS mantiene sus réplicas disponibles.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa que no existan eventos de error persistentes asociados al Pod de validación.

  ```bash
  kubectl get events --sort-by=.lastTimestamp | tail -n 15
  ```

  > **Salida esperada:** Los eventos recientes muestran scheduling y arranque correctos del Pod sin errores repetitivos.
  {: .lab-note .output .compact}

### Tarea 5.3. Confirmar el estado final y limpiar

Cerrarás la práctica verificando el clúster de tres nodos y eliminando solamente la carga temporal utilizada para las pruebas funcionales.

- {% include step_label.html %} Elimina el Pod de prueba y su manifiesto local.

  > **Importante:** No elimines `cka-worker2` del clúster. A partir de este punto será parte de la infraestructura utilizada por las siguientes prácticas.
  {: .lab-note .important .compact}

  ```bash
  kubectl delete pod worker2-test
  ```

  ```bash
  rm -f lab3-node-test.yaml
  ```

  > **Salida esperada:** El Pod temporal se elimina y el nodo permanece unido.
  {: .lab-note .output .compact}

- {% include step_label.html %} Valida el estado final de los tres nodos y confirma que todos están schedulable.

  ```bash
  kubectl get nodes -o wide
  ```

  > **Salida esperada:** `cka-control`, `cka-worker1` y `cka-worker2` aparecen `Ready`; ningún worker muestra `SchedulingDisabled`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Realiza una última comprobación del API Server y de los Pods de sistema.

  ```bash
  kubectl get --raw='/readyz'
  ```

  ```bash
  kubectl get pods -n kube-system -o wide
  ```

  > **Salida esperada:** El API Server responde `ok` y los componentes esenciales de `kube-system` permanecen operativos.
  {: .lab-note .output .compact}

{% capture r5 %}{{ results[4] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r5 %}

{% include support-prompt.html task="tarea5" %}
