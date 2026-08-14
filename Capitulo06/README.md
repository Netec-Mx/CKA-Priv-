# 4 Práctica 6: Diagnóstico de CNI, kube-proxy y CoreDNS

## Metadatos

| Campo | Valor |
|---|---|
| Duración | 55 minutos |
| Complejidad | Media |
| Nivel de Bloom | Aplicar |

## Descripción general

En esta práctica se validará la conectividad de red del clúster desde la perspectiva de un administrador de Kubernetes. Se comprobarán los componentes Calico, kube-proxy y CoreDNS, se desplegará una aplicación distribuida entre workers y se diagnosticará la cadena completa `Service -> selector -> EndpointSlice -> Pod -> puerto`.

También se introducirán fallas controladas y reversibles: un selector incorrecto en un Service y una resolución DNS deliberadamente errónea para un dominio de prueba. La práctica termina dejando recursos operativos que servirán como línea base para prácticas posteriores.

> **Nota sobre CIDR de Pods:** la configuración global del curso establece `192.168.0.0/16` como Pod CIDR y `10.96.0.0/12` como Service CIDR. Algunas instalaciones de kubeadm usan históricamente `10.244.0.0/16`; no modifique el CNI para forzar ese valor durante esta práctica. Verifique y documente el rango realmente configurado en su clúster.

## Objetivos de aprendizaje

Al finalizar la práctica, podrá:

- [ ] Verificar el estado operativo de Calico, kube-proxy, CoreDNS y los nodos del clúster.
- [ ] Comprobar conectividad TCP directa entre Pods ubicados en workers diferentes.
- [ ] Diagnosticar la relación entre un Service, sus selectores, EndpointSlices y Pods de backend.
- [ ] Inspeccionar reglas de kube-proxy en modo `iptables` desde un nodo worker.
- [ ] Respaldar, modificar de forma controlada y restaurar el `Corefile` de CoreDNS.
- [ ] Conservar recursos funcionales en el namespace `cka-net` como línea base de conectividad.

## Prerrequisitos

### Conocimientos requeridos

- Uso básico de `kubectl get`, `describe`, `logs`, `exec`, `apply`, `delete` y `rollout restart`.
- Conceptos de Pods, Deployments, Services ClusterIP, etiquetas y selectores.
- Comprensión básica de CNI, kube-proxy, CoreDNS, IP de Pod y ClusterIP.
- Interpretación de eventos de Kubernetes y de salidas de comandos Linux de red.

### Acceso requerido

- Acceso mediante `kubectl` con permisos `cluster-admin`.
- Acceso SSH con `sudo` a `worker1` o `worker2`.
- Acceso temporal a las imágenes:
  - `registry.k8s.io/e2e-test-images/agnhost:2.53`
  - `docker.io/library/busybox:1.36.1`
- Clúster Kubernetes `1.31.6` funcional, con:
  - Calico `3.29.2`
  - CoreDNS `1.11.3`
  - kube-proxy `1.31.6` en modo `iptables`
  - containerd `1.7.24-1`

## Entorno de laboratorio

### Topología esperada

| Nodo | Dirección IP | Función |
|---|---:|---|
| `cp1` | `10.10.10.10` | Control plane |
| `worker1` | `10.10.10.11` | Worker |
| `worker2` | `10.10.10.12` | Worker |

### Redes esperadas

| Red | CIDR | Uso |
|---|---|---|
| Red de nodos | `10.10.10.0/24` | Comunicación entre nodos |
| Red de Pods | `192.168.0.0/16` | Direcciones de Pods según la configuración global del curso |
| Red de Services | `10.96.0.0/12` | ClusterIP virtuales |
| DNS de Services | `10.96.0.10` | Servicio CoreDNS |

### Variables de trabajo

Ejecute los siguientes comandos desde la estación de administración o desde `cp1` con un `kubectl` configurado:

```bash
export NS=cka-net
export APP=web-net
export SERVICE=web-net
export DEBUG_POD=net-debug
export IMAGE_WEB=registry.k8s.io/e2e-test-images/agnhost:2.53
export IMAGE_DEBUG=docker.io/library/busybox:1.36.1

kubectl config current-context
kubectl cluster-info
```

La salida debe mostrar un contexto válido y acceso al API Server en:

```text
https://10.10.10.10:6443
```

---

## Procedimiento paso a paso

### Paso 1. Verificar el estado inicial del plano de red

**Objetivo:** confirmar que los nodos y componentes esenciales de red están operativos antes de desplegar cargas de trabajo de diagnóstico.

#### Instrucciones

1. Compruebe el estado y la ubicación de los nodos:

   ```bash
   kubectl get nodes -o wide
   ```

2. Revise los Pods de sistema y sus nodos asignados:

   ```bash
   kubectl get pods -n kube-system -o wide
   ```

3. Verifique específicamente los componentes Calico, kube-proxy y CoreDNS:

   ```bash
   kubectl get pods -n kube-system -l k8s-app=calico-node -o wide
   kubectl get pods -n kube-system -l k8s-app=kube-proxy -o wide
   kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide
   ```

4. Verifique los DaemonSets relevantes:

   ```bash
   kubectl get daemonsets -n kube-system
   ```

5. Consulte los eventos recientes del espacio de nombres del sistema:

   ```bash
   kubectl get events -n kube-system --sort-by='.lastTimestamp' | tail -n 30
   ```

6. Inspeccione la configuración de kube-proxy y confirme el modo esperado:

   ```bash
   kubectl -n kube-system get configmap kube-proxy -o yaml | grep -A3 -B2 'mode:'
   ```

7. Inspeccione los CIDR informados por los nodos:

   ```bash
   kubectl get nodes \
     -o custom-columns=NAME:.metadata.name,PODCIDR:.spec.podCIDR,PODCIDRS:.spec.podCIDRs
   ```

#### Salida esperada

- Los nodos `cp1`, `worker1` y `worker2` deben aparecer como `Ready`.
- Debe existir un Pod `calico-node` en cada nodo.
- Debe existir un Pod `kube-proxy` en cada nodo.
- CoreDNS debe tener réplicas en estado `Running` y `Ready`.
- Los DaemonSets de Calico y kube-proxy deben mostrar el número deseado de Pods disponibles.
- La configuración de kube-proxy debe indicar:

  ```text
  mode: "iptables"
  ```

- El Pod CIDR debe pertenecer a la red configurada para el laboratorio, normalmente `192.168.0.0/16`.

#### Verificación

Ejecute:

```bash
kubectl get nodes
kubectl get daemonsets -n kube-system
kubectl get deployment -n kube-system coredns
```

No continúe si algún nodo está en `NotReady`, si Calico no tiene un Pod disponible por nodo o si CoreDNS no está disponible.

---

### Paso 2. Inspeccionar la configuración CNI desde un worker

**Objetivo:** comprobar que el nodo posee configuración y binarios CNI disponibles para kubelet y containerd.

#### Instrucciones

1. Conéctese por SSH a `worker1`:

   ```bash
   ssh <USUARIO>@10.10.10.11
   ```

2. Revise los archivos de configuración CNI:

   ```bash
   sudo ls -la /etc/cni/net.d/
   sudo find /etc/cni/net.d/ -maxdepth 1 -type f -printf '%f\n'
   ```

3. Revise los binarios CNI instalados:

   ```bash
   sudo ls -la /opt/cni/bin/
   ```

4. Localice referencias a Calico dentro de la configuración:

   ```bash
   sudo grep -RniE 'calico|vxlan|ipam' /etc/cni/net.d/
   ```

5. Revise interfaces y rutas del nodo:

   ```bash
   ip addr
   ip route
   ```

6. Compruebe el estado de kubelet y containerd:

   ```bash
   sudo systemctl is-active kubelet
   sudo systemctl is-active containerd
   ```

7. Revise mensajes recientes de kubelet relacionados con CNI o red:

   ```bash
   sudo journalctl -u kubelet --since "30 minutes ago" \
     | grep -iE 'cni|network|sandbox|calico' \
     | tail -n 50
   ```

#### Salida esperada

- Debe existir al menos un archivo `.conflist`, `.conf` o `.json` bajo `/etc/cni/net.d/`.
- Deben existir binarios CNI en `/opt/cni/bin/`.
- La configuración debe contener referencias a Calico.
- `kubelet` y `containerd` deben estar en estado `active`.
- La tabla de rutas debe incluir rutas relacionadas con la red de Pods.
- Pueden existir interfaces denominadas `cali*`, `vxlan.calico` u otras interfaces creadas por Calico. El nombre exacto depende de la configuración.

#### Verificación

Regrese a la estación de administración:

```bash
exit
kubectl get pods -n kube-system -l k8s-app=calico-node -o wide
```

Documente el nombre del Pod de Calico que se ejecuta en `worker1`.

---

### Paso 3. Crear el namespace y el Deployment distribuido

**Objetivo:** desplegar dos Pods HTTP en workers distintos para validar conectividad Pod a Pod entre nodos.

#### Instrucciones

1. Cree el namespace de trabajo:

   ```bash
   kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f -
   ```

2. Cree el manifiesto del Deployment:

   ```bash
   cat <<'EOF' > web-net-deployment.yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: web-net
     namespace: cka-net
     labels:
       app: web-net
   spec:
     replicas: 2
     selector:
       matchLabels:
         app: web-net
     template:
       metadata:
         labels:
           app: web-net
       spec:
         affinity:
           podAntiAffinity:
             requiredDuringSchedulingIgnoredDuringExecution:
             - labelSelector:
                 matchExpressions:
                 - key: app
                   operator: In
                   values:
                   - web-net
               topologyKey: kubernetes.io/hostname
         containers:
         - name: agnhost
           image: registry.k8s.io/e2e-test-images/agnhost:2.53
           args:
           - netexec
           - --http-port=8080
           ports:
           - name: http
             containerPort: 8080
   EOF
   ```

3. Aplique el manifiesto:

   ```bash
   kubectl apply -f web-net-deployment.yaml
   ```

4. Espere a que el Deployment esté disponible:

   ```bash
   kubectl rollout status deployment/web-net -n "${NS}" --timeout=120s
   ```

5. Consulte los Pods, sus IP y los nodos donde se ejecutan:

   ```bash
   kubectl get pods -n "${NS}" -l app=web-net -o wide
   ```

6. Revise los eventos del namespace:

   ```bash
   kubectl get events -n "${NS}" --sort-by='.lastTimestamp'
   ```

#### Salida esperada

Deben existir dos Pods de `web-net` en estado `Running`, preferiblemente distribuidos así:

```text
NAME                       READY   STATUS    IP                NODE
web-net-xxxxxxxxxx-aaaaa   1/1     Running   192.168.x.x       worker1
web-net-xxxxxxxxxx-bbbbb   1/1     Running   192.168.y.y       worker2
```

Las direcciones IP exactas dependen del IPAM de Calico.

#### Verificación

Confirme que los Pods están en workers distintos:

```bash
kubectl get pods -n "${NS}" -l app=web-net \
  -o custom-columns=NAME:.metadata.name,IP:.status.podIP,NODE:.spec.nodeName,READY:.status.containerStatuses[0].ready
```

Si ambos Pods se ubican en el mismo nodo, revise los eventos de scheduling y confirme que existen al menos dos workers disponibles.

---

### Paso 4. Crear el Service ClusterIP y revisar sus EndpointSlices

**Objetivo:** crear un punto de acceso estable para los Pods de backend y comprobar la cadena entre selector, Pods y endpoints.

#### Instrucciones

1. Cree el Service `web-net`:

   ```bash
   cat <<'EOF' > web-net-service.yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: web-net
     namespace: cka-net
     labels:
       app: web-net
   spec:
     type: ClusterIP
     selector:
       app: web-net
     ports:
     - name: http
       protocol: TCP
       port: 80
       targetPort: 8080
   EOF
   ```

2. Aplique el Service:

   ```bash
   kubectl apply -f web-net-service.yaml
   ```

3. Consulte el Service y su ClusterIP:

   ```bash
   kubectl get service -n "${NS}" "${SERVICE}" -o wide
   ```

4. Inspeccione el selector y los puertos del Service:

   ```bash
   kubectl describe service -n "${NS}" "${SERVICE}"
   ```

5. Liste los EndpointSlices asociados al Service:

   ```bash
   kubectl get endpointslices -n "${NS}" \
     -l kubernetes.io/service-name="${SERVICE}" \
     -o wide
   ```

6. Obtenga el detalle de los endpoints:

   ```bash
   kubectl get endpointslices -n "${NS}" \
     -l kubernetes.io/service-name="${SERVICE}" \
     -o yaml
   ```

7. Compare las IP de endpoints con las IP de los Pods:

   ```bash
   kubectl get pods -n "${NS}" -l app=web-net -o wide
   ```

#### Salida esperada

El Service debe tener una ClusterIP dentro de `10.96.0.0/12`, por ejemplo:

```text
NAME      TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)   AGE
web-net   ClusterIP   10.96.x.x      <none>        80/TCP    10s
```

Los EndpointSlices deben contener dos direcciones IP, una por cada Pod `web-net`, con puerto `8080`.

#### Verificación

Ejecute:

```bash
kubectl get endpointslices -n "${NS}" \
  -l kubernetes.io/service-name="${SERVICE}" \
  -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{" ready="}{.conditions.ready}{"\n"}{end}'
```

Debe observar dos endpoints con condición `ready=true`.

---

### Paso 5. Crear un Pod de diagnóstico y validar conectividad directa Pod a Pod

**Objetivo:** distinguir conectividad directa hacia una IP de Pod de la conectividad mediante un Service.

#### Instrucciones

1. Cree el Pod persistente de diagnóstico:

   ```bash
   cat <<'EOF' > net-debug.yaml
   apiVersion: v1
   kind: Pod
   metadata:
     name: net-debug
     namespace: cka-net
     labels:
       app: net-debug
   spec:
     containers:
     - name: busybox
       image: docker.io/library/busybox:1.36.1
       command:
       - sh
       - -c
       - sleep 36000
   EOF
   ```

2. Aplique el manifiesto:

   ```bash
   kubectl apply -f net-debug.yaml
   ```

3. Espere a que el Pod esté listo:

   ```bash
   kubectl wait --for=condition=Ready pod/"${DEBUG_POD}" \
     -n "${NS}" --timeout=120s
   ```

4. Consulte el nodo e IP del Pod de diagnóstico:

   ```bash
   kubectl get pod -n "${NS}" "${DEBUG_POD}" -o wide
   ```

5. Obtenga las IP de los dos Pods backend:

   ```bash
   kubectl get pods -n "${NS}" -l app=web-net \
     -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.podIP}{" "}{.spec.nodeName}{"\n"}{end}'
   ```

6. Guarde una IP de backend en una variable:

   ```bash
   export BACKEND_IP=$(kubectl get pods -n "${NS}" -l app=web-net \
     -o jsonpath='{.items[0].status.podIP}')

   echo "${BACKEND_IP}"
   ```

7. Pruebe ICMP hacia el Pod backend:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- ping -c 3 "${BACKEND_IP}"
   ```

8. Pruebe TCP/HTTP directamente contra el puerto del contenedor:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     wget -T 3 -t 1 -qO- "http://${BACKEND_IP}:8080/"
   ```

#### Salida esperada

- El `ping` debe recibir respuestas si ICMP no está bloqueado por una política de red.
- La solicitud HTTP debe devolver una respuesta del servidor `agnhost`, normalmente con información de la solicitud o del backend.

Ejemplo orientativo:

```text
Hostname: web-net-xxxxxxxxxx-aaaaa
...
```

#### Verificación

La prueba directa debe funcionar antes de probar el Service. Si falla:

1. Verifique IP y nodo del cliente y backend.
2. Revise el estado de Calico.
3. Revise rutas e interfaces del nodo.
4. Revise si existen `NetworkPolicy` aplicables:

   ```bash
   kubectl get networkpolicy -A
   ```

---

### Paso 6. Validar el Service ClusterIP y DNS interno

**Objetivo:** comprobar que kube-proxy redirige tráfico desde la ClusterIP hacia los endpoints disponibles y que CoreDNS resuelve el nombre del Service.

#### Instrucciones

1. Obtenga la ClusterIP del Service:

   ```bash
   export SERVICE_IP=$(kubectl get service -n "${NS}" "${SERVICE}" \
     -o jsonpath='{.spec.clusterIP}')

   echo "${SERVICE_IP}"
   ```

2. Pruebe conectividad HTTP mediante la ClusterIP:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     wget -T 3 -t 1 -qO- "http://${SERVICE_IP}/"
   ```

3. Consulte la configuración DNS entregada al Pod:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- cat /etc/resolv.conf
   ```

4. Resuelva el nombre corto del Service desde el mismo namespace:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- nslookup web-net
   ```

5. Resuelva el FQDN del Service:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     nslookup web-net.cka-net.svc.cluster.local
   ```

6. Pruebe HTTP usando el nombre DNS:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     wget -T 3 -t 1 -qO- "http://web-net/"
   ```

7. Consulte logs recientes de CoreDNS:

   ```bash
   kubectl logs -n kube-system deployment/coredns --tail=50
   ```

#### Salida esperada

- `/etc/resolv.conf` debe contener una línea similar a:

  ```text
  nameserver 10.96.0.10
  ```

- `nslookup web-net` debe resolver a la ClusterIP del Service.
- La solicitud HTTP mediante ClusterIP y nombre DNS debe devolver una respuesta válida del backend.
- Las respuestas pueden provenir alternativamente de cualquiera de los dos Pods `web-net`.

#### Verificación

Ejecute varias solicitudes para confirmar balanceo de carga a nivel de Service:

```bash
for i in 1 2 3 4 5; do
  kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
    wget -T 3 -t 1 -qO- "http://web-net/" | head -n 1
done
```

No se exige alternancia perfecta por solicitud. kube-proxy distribuye conexiones; el resultado depende de la creación de conexiones y del comportamiento del cliente.

---

### Paso 7. Introducir y diagnosticar una falla de selector en el Service

**Objetivo:** demostrar que una falla de Service puede existir aunque la conectividad directa Pod a Pod siga funcionando.

#### Instrucciones

1. Confirme la prueba directa hacia un backend antes de introducir la falla:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     wget -T 3 -t 1 -qO- "http://${BACKEND_IP}:8080/" | head
   ```

2. Modifique temporalmente el selector del Service para que no coincida con las etiquetas de los Pods:

   ```bash
   kubectl patch service -n "${NS}" "${SERVICE}" \
     --type merge \
     -p '{"spec":{"selector":{"app":"web-net-roto"}}}'
   ```

3. Verifique el selector modificado:

   ```bash
   kubectl describe service -n "${NS}" "${SERVICE}"
   ```

4. Espere unos segundos y consulte los EndpointSlices:

   ```bash
   sleep 10

   kubectl get endpointslices -n "${NS}" \
     -l kubernetes.io/service-name="${SERVICE}" \
     -o wide
   ```

5. Consulte los detalles de endpoints:

   ```bash
   kubectl get endpointslices -n "${NS}" \
     -l kubernetes.io/service-name="${SERVICE}" \
     -o yaml
   ```

6. Pruebe el acceso directo por IP de Pod, que debe continuar funcionando:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     wget -T 3 -t 1 -qO- "http://${BACKEND_IP}:8080/"
   ```

7. Pruebe el acceso mediante el Service, que debe fallar o no devolver respuesta útil:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     wget -T 3 -t 1 -qO- "http://${SERVICE_IP}/"
   ```

8. Revise los eventos del namespace:

   ```bash
   kubectl get events -n "${NS}" --sort-by='.lastTimestamp' | tail -n 30
   ```

#### Salida esperada

- Los Pods `web-net` deben permanecer en `Running`.
- La conectividad directa a `http://<IP_POD>:8080/` debe continuar funcionando.
- Los EndpointSlices del Service deben quedar sin endpoints utilizables o sin direcciones de backend.
- El acceso a la ClusterIP del Service debe fallar, agotarse por timeout o no obtener una respuesta HTTP.

#### Verificación

La interpretación correcta es:

| Prueba | Resultado esperado durante la falla | Interpretación |
|---|---|---|
| Pod a Pod por IP | Correcta | CNI y conectividad básica operativos |
| Service por ClusterIP | Fallida | Problema en la cadena del Service |
| EndpointSlice | Sin endpoints válidos | Selector no coincide con Pods |
| DNS del Service | Puede resolver correctamente | CoreDNS no es la causa del fallo |

---

### Paso 8. Restaurar el selector correcto y validar endpoints

**Objetivo:** corregir la falla introducida y confirmar la recuperación completa del Service.

#### Instrucciones

1. Restaure el selector correcto:

   ```bash
   kubectl patch service -n "${NS}" "${SERVICE}" \
     --type merge \
     -p '{"spec":{"selector":{"app":"web-net"}}}'
   ```

2. Espere a que Kubernetes reconstruya los endpoints:

   ```bash
   sleep 10
   ```

3. Compruebe el Service:

   ```bash
   kubectl describe service -n "${NS}" "${SERVICE}"
   ```

4. Compruebe los EndpointSlices:

   ```bash
   kubectl get endpointslices -n "${NS}" \
     -l kubernetes.io/service-name="${SERVICE}" \
     -o wide
   ```

5. Pruebe nuevamente la ClusterIP:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     wget -T 3 -t 1 -qO- "http://${SERVICE_IP}/"
   ```

6. Pruebe nuevamente el nombre DNS:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     wget -T 3 -t 1 -qO- "http://web-net/"
   ```

#### Salida esperada

- Deben reaparecer dos endpoints disponibles.
- La ClusterIP debe volver a responder.
- El nombre `web-net` debe resolver y permitir acceso HTTP al Service.

#### Verificación

```bash
kubectl get endpointslices -n "${NS}" \
  -l kubernetes.io/service-name="${SERVICE}" \
  -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{" ready="}{.conditions.ready}{"\n"}{end}'
```

Deben mostrarse dos direcciones con `ready=true`.

---

### Paso 9. Inspeccionar kube-proxy y reglas iptables desde un worker

**Objetivo:** validar que kube-proxy mantiene reglas de traducción para la ClusterIP del Service y distinguir el plano de datos del Service de la conectividad directa entre Pods.

#### Instrucciones

1. Identifique el nodo donde se ejecuta `net-debug`:

   ```bash
   kubectl get pod -n "${NS}" "${DEBUG_POD}" \
     -o jsonpath='{.spec.nodeName}{"\n"}'
   ```

2. Conéctese por SSH a ese worker. Si el Pod está en `worker1`:

   ```bash
   ssh <USUARIO>@10.10.10.11
   ```

3. Confirme que iptables usa una tabla `nat` con cadenas de Kubernetes:

   ```bash
   sudo iptables-save -t nat | grep -E 'KUBE-SERVICES|KUBE-SVC|KUBE-SEP' | head -n 30
   ```

4. Busque referencias a la ClusterIP del Service:

   ```bash
   sudo iptables-save -t nat | grep "${SERVICE_IP}"
   ```

5. Busque reglas con comentarios relacionados con el Service:

   ```bash
   sudo iptables-save -t nat | grep -E 'cka-net/web-net|web-net'
   ```

6. Consulte el Pod kube-proxy ejecutado en ese nodo:

   ```bash
   kubectl get pods -n kube-system -l k8s-app=kube-proxy -o wide
   ```

7. Obtenga logs recientes de kube-proxy. Sustituya `<POD_KUBE_PROXY>` por el nombre correspondiente al worker inspeccionado:

   ```bash
   kubectl logs -n kube-system <POD_KUBE_PROXY> --tail=100
   ```

8. Verifique el modo configurado desde la estación de administración:

   ```bash
   kubectl -n kube-system get configmap kube-proxy \
     -o jsonpath='{.data.config\.conf}' | grep -A2 -B2 'mode:'
   ```

#### Salida esperada

- Deben existir cadenas como `KUBE-SERVICES`, `KUBE-SVC-*` y `KUBE-SEP-*`.
- Debe existir una regla que relacione la ClusterIP de `web-net` con una cadena `KUBE-SVC-*`.
- La cadena del Service debe apuntar a una o más cadenas de endpoint `KUBE-SEP-*`.
- Los logs de kube-proxy no deben mostrar errores repetitivos de sincronización.

> Las cadenas exactas y los hash incluidos en sus nombres cambian entre clústeres. No memorice los identificadores; valide la relación entre ClusterIP, Service y endpoints.

#### Verificación

La secuencia de diagnóstico aplicada hasta este punto debe ser:

1. Confirmar el síntoma.
2. Determinar el alcance: Pod a Pod, Service o DNS.
3. Revisar Pods, etiquetas y selector.
4. Revisar EndpointSlices.
5. Revisar kube-proxy y reglas del nodo.
6. Corregir la configuración afectada.
7. Repetir la prueba inicial.

Regrese a la estación de administración:

```bash
exit
```

---

### Paso 10. Respaldar y modificar temporalmente CoreDNS

**Objetivo:** introducir una resolución DNS errónea limitada a un dominio de prueba, preservar una copia de seguridad y verificar el comportamiento de CoreDNS.

#### Instrucciones

1. Cree un directorio local para respaldos:

   ```bash
   mkdir -p coredns-backup
   ```

2. Respalde el ConfigMap actual de CoreDNS:

   ```bash
   kubectl get configmap coredns -n kube-system -o yaml \
     > coredns-backup/coredns-before-lab.yaml
   ```

3. Confirme que el archivo se creó:

   ```bash
   ls -lh coredns-backup/coredns-before-lab.yaml
   ```

4. Consulte el `Corefile` actual:

   ```bash
   kubectl get configmap coredns -n kube-system \
     -o jsonpath='{.data.Corefile}'
   echo
   ```

5. Edite el ConfigMap:

   ```bash
   kubectl edit configmap coredns -n kube-system
   ```

6. Dentro del bloque principal del `Corefile`, agregue el siguiente bloque **antes de `forward`**. Mantenga la indentación coherente con el archivo existente:

   ```text
       hosts {
           203.0.113.53 dns-error.cka.test
           fallthrough
       }
   ```

   El dominio `dns-error.cka.test` es exclusivo de esta práctica. La dirección `203.0.113.53` pertenece al bloque documental TEST-NET-3 y se utiliza únicamente para simular una respuesta incorrecta.

7. Guarde y cierre el editor.

8. Espere unos segundos y revise los logs de CoreDNS:

   ```bash
   sleep 10

   kubectl logs -n kube-system deployment/coredns --tail=100
   ```

9. Compruebe si el Deployment sigue disponible:

   ```bash
   kubectl rollout status deployment/coredns -n kube-system --timeout=120s
   ```

10. Desde `net-debug`, consulte el dominio de prueba:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     nslookup dns-error.cka.test
   ```

11. Confirme que el Service normal sigue resolviendo:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     nslookup web-net.cka-net.svc.cluster.local
   ```

#### Salida esperada

- `dns-error.cka.test` debe resolver a:

  ```text
  203.0.113.53
  ```

- El dominio del Service `web-net.cka-net.svc.cluster.local` debe continuar resolviendo a la ClusterIP real de `web-net`.
- CoreDNS debe permanecer disponible.
- Si el `Corefile` contiene el plugin `reload`, el cambio normalmente se aplica de forma automática. Si no se aplica, reinicie controladamente CoreDNS en el siguiente paso.

#### Verificación

Compruebe que la falla está limitada al dominio de prueba:

```bash
kubectl exec -n "${NS}" "${DEBUG_POD}" -- nslookup dns-error.cka.test
kubectl exec -n "${NS}" "${DEBUG_POD}" -- nslookup kubernetes.default
kubectl exec -n "${NS}" "${DEBUG_POD}" -- nslookup web-net
```

Solo `dns-error.cka.test` debe resolver a la IP simulada.

---

### Paso 11. Restaurar CoreDNS desde el respaldo

**Objetivo:** revertir el cambio de DNS, restaurar la configuración original y verificar que CoreDNS vuelve a responder según la configuración inicial.

#### Instrucciones

1. Restaure el ConfigMap desde el respaldo:

   ```bash
   kubectl apply -f coredns-backup/coredns-before-lab.yaml
   ```

2. Reinicie el Deployment de CoreDNS para asegurar la recarga controlada de la configuración:

   ```bash
   kubectl rollout restart deployment/coredns -n kube-system
   ```

3. Espere a que CoreDNS vuelva a estar disponible:

   ```bash
   kubectl rollout status deployment/coredns -n kube-system --timeout=120s
   ```

4. Revise los Pods de CoreDNS:

   ```bash
   kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide
   ```

5. Revise logs recientes:

   ```bash
   kubectl logs -n kube-system deployment/coredns --tail=50
   ```

6. Compruebe que el dominio de prueba ya no devuelve la IP simulada:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     nslookup dns-error.cka.test
   ```

7. Confirme que el DNS de Kubernetes sigue funcionando:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     nslookup kubernetes.default
   ```

8. Confirme nuevamente la resolución del Service:

   ```bash
   kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
     nslookup web-net.cka-net.svc.cluster.local
   ```

#### Salida esperada

- Los Pods de CoreDNS deben estar en estado `Running` y `Ready`.
- `dns-error.cka.test` no debe resolver a `203.0.113.53`.
- `kubernetes.default` y `web-net.cka-net.svc.cluster.local` deben resolver correctamente.

#### Verificación

Compruebe la ausencia de la entrada temporal:

```bash
kubectl get configmap coredns -n kube-system \
  -o jsonpath='{.data.Corefile}' | grep -n 'dns-error.cka.test' \
  || echo "Entrada temporal eliminada correctamente."
```

---

## Validación y pruebas finales

Ejecute la siguiente secuencia de validación para confirmar que el entorno queda listo para prácticas posteriores.

### Estado de recursos

```bash
kubectl get nodes
kubectl get pods -n kube-system -l k8s-app=calico-node
kubectl get pods -n kube-system -l k8s-app=kube-proxy
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl get all -n "${NS}"
```

### Validación de Pods y distribución

```bash
kubectl get pods -n "${NS}" -l app=web-net -o wide
kubectl get pod -n "${NS}" "${DEBUG_POD}" -o wide
```

Criterios:

- Dos Pods `web-net` en estado `Running`.
- Preferiblemente un Pod `web-net` en cada worker.
- `net-debug` en estado `Running`.

### Validación de selector y EndpointSlices

```bash
kubectl get service -n "${NS}" "${SERVICE}" -o yaml
kubectl get endpointslices -n "${NS}" \
  -l kubernetes.io/service-name="${SERVICE}" \
  -o wide
```

Criterios:

- El selector del Service debe ser:

  ```yaml
  selector:
    app: web-net
  ```

- Deben existir endpoints disponibles para ambos Pods backend.

### Validación de conectividad directa y mediante Service

```bash
export BACKEND_IP=$(kubectl get pods -n "${NS}" -l app=web-net \
  -o jsonpath='{.items[0].status.podIP}')

export SERVICE_IP=$(kubectl get service -n "${NS}" "${SERVICE}" \
  -o jsonpath='{.spec.clusterIP}')

kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
  wget -T 3 -t 1 -qO- "http://${BACKEND_IP}:8080/"

kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
  wget -T 3 -t 1 -qO- "http://${SERVICE_IP}/"

kubectl exec -n "${NS}" "${DEBUG_POD}" -- \
  wget -T 3 -t 1 -qO- "http://web-net/"
```

Criterios:

- La prueba directa hacia `IP_POD:8080` debe responder.
- La prueba hacia la ClusterIP debe responder.
- La prueba usando el nombre DNS del Service debe responder.

### Evidencia técnica mínima

Conserve, como mínimo, la salida de los siguientes comandos en su bitácora del laboratorio:

```bash
kubectl get nodes -o wide
kubectl get pods -n kube-system -o wide
kubectl get pods -n "${NS}" -o wide
kubectl describe service -n "${NS}" "${SERVICE}"
kubectl get endpointslices -n "${NS}" \
  -l kubernetes.io/service-name="${SERVICE}" -o yaml
kubectl get events -n "${NS}" --sort-by='.lastTimestamp'
kubectl logs -n kube-system deployment/coredns --tail=50
```

---

## Troubleshooting

### Problema 1: El Service resuelve por DNS, pero la ClusterIP no responde

**Síntomas**

```bash
kubectl exec -n cka-net net-debug -- nslookup web-net
```

Resuelve una ClusterIP válida, pero:

```bash
kubectl exec -n cka-net net-debug -- \
  wget -T 3 -t 1 -qO- http://web-net/
```

falla por timeout o no obtiene respuesta.

**Causa probable**

El selector del Service no coincide con las etiquetas de los Pods, por lo que el Service no tiene endpoints disponibles. DNS solo resuelve el nombre hacia la ClusterIP; no valida que existan backends saludables.

**Corrección**

1. Revise selector y etiquetas:

   ```bash
   kubectl describe service -n cka-net web-net
   kubectl get pods -n cka-net --show-labels
   ```

2. Revise EndpointSlices:

   ```bash
   kubectl get endpointslices -n cka-net \
     -l kubernetes.io/service-name=web-net -o yaml
   ```

3. Restaure el selector correcto:

   ```bash
   kubectl patch service -n cka-net web-net \
     --type merge \
     -p '{"spec":{"selector":{"app":"web-net"}}}'
   ```

4. Espere y pruebe nuevamente:

   ```bash
   kubectl exec -n cka-net net-debug -- \
     wget -T 3 -t 1 -qO- http://web-net/
   ```

---

### Problema 2: Pods en workers distintos no se comunican por IP

**Síntomas**

La prueba directa falla:

```bash
kubectl exec -n cka-net net-debug -- \
  wget -T 3 -t 1 -qO- http://<IP_POD_BACKEND>:8080/
```

Los Pods pueden estar en `Running`, pero no hay conectividad entre nodos.

**Causa probable**

Problema en Calico, rutas de Pods, encapsulación VXLAN, reglas de firewall entre nodos o configuración CNI local incompleta. En este laboratorio, la comunicación VXLAN requiere que UDP `4789` no esté bloqueado entre nodos.

**Corrección**

1. Revise Calico y sus eventos:

   ```bash
   kubectl get pods -n kube-system -l k8s-app=calico-node -o wide
   kubectl get events -n kube-system --sort-by='.lastTimestamp' | tail -n 50
   ```

2. Revise el nodo afectado:

   ```bash
   kubectl describe node worker1
   kubectl describe node worker2
   ```

3. En el worker afectado, revise CNI, interfaces y rutas:

   ```bash
   sudo ls -la /etc/cni/net.d/
   ip addr
   ip route
   sudo journalctl -u kubelet --since "30 minutes ago" | tail -n 100
   ```

4. Verifique conectividad entre nodos y reglas de firewall para VXLAN:

   ```bash
   ping -c 3 10.10.10.12
   sudo ss -ulnp | grep 4789
   ```

5. No reinicie componentes ni modifique manifiestos hasta haber identificado si la falla es:
   - local a un nodo;
   - inter-nodo;
   - específica del CNI;
   - causada por una política de red;
   - causada por filtrado de red externo al clúster.

---

## Limpieza

> **Importante:** esta práctica conserva deliberadamente el namespace `cka-net`, el Deployment `web-net`, el Service `web-net` y el Pod `net-debug`. Estos recursos son la línea base de conectividad para las prácticas 7 y 8.

### Recursos que deben permanecer

Verifique que continúan presentes:

```bash
kubectl get namespace cka-net
kubectl get deployment -n cka-net web-net
kubectl get service -n cka-net web-net
kubectl get pod -n cka-net net-debug
```

### Archivos locales que puede eliminar

Puede eliminar únicamente los manifiestos locales si ya no los necesita como evidencia:

```bash
rm -f web-net-deployment.yaml
rm -f web-net-service.yaml
rm -f net-debug.yaml
```

Conserve el respaldo de CoreDNS hasta finalizar el bloque completo de prácticas:

```bash
ls -lh coredns-backup/
```

### Verificación final de restauración de CoreDNS

```bash
kubectl get configmap coredns -n kube-system \
  -o jsonpath='{.data.Corefile}' | grep -n 'dns-error.cka.test' \
  && echo "ERROR: la entrada temporal sigue presente." \
  || echo "CoreDNS restaurado correctamente."
```

---

## Resumen

En esta práctica se aplicó una metodología de troubleshooting orientada a administración de clúster:

1. Se verificó el estado de nodos, Calico, kube-proxy y CoreDNS.
2. Se inspeccionó la configuración CNI, interfaces y rutas de un worker.
3. Se validó conectividad directa hacia una IP de Pod para aislar el plano CNI.
4. Se comprobó la cadena `Service -> selector -> EndpointSlice -> Pod -> puerto`.
5. Se confirmó que kube-proxy en modo `iptables` implementa la redirección desde una ClusterIP hacia endpoints reales.
6. Se verificó la configuración DNS dentro de un Pod y el comportamiento de CoreDNS.
7. Se introdujeron fallas reversibles y se restauró el estado funcional del clúster.

La principal conclusión operativa es que una resolución DNS correcta no garantiza que un Service tenga endpoints, y que una falla de Service no implica necesariamente una falla de conectividad Pod a Pod. La secuencia de diagnóstico debe comenzar por el síntoma, delimitar el alcance y revisar primero los recursos Kubernetes antes de realizar cambios en los nodos.

### Recursos recomendados

- [Modelo de red de Kubernetes](https://kubernetes.io/docs/concepts/cluster-administration/networking/)
- [Depuración de Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Documentación de CoreDNS en Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/coredns/)
- [Documentación de Calico](https://docs.tigera.io/calico/latest/about/)
- [Referencia de kube-proxy](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-proxy/)
