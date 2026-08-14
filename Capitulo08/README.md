# 3 Práctica 8: Escenarios integrales de troubleshooting administrativo

## Metadatos

| Campo | Valor |
|---|---|
| Duración | 75 minutos |
| Complejidad | Alta |
| Nivel de Bloom | Aplicar |

## Descripción general

En esta práctica integrarás diagnóstico de nodos, kubelet, scheduling, DNS, Services, EndpointSlices y almacenamiento persistente. Recibirás síntomas observables provocados por fallas reversibles y aisladas en recursos de entrenamiento, y deberás aplicar una metodología CKA: observar, delimitar, obtener evidencia, formular una hipótesis, corregir mínimamente y validar de extremo a extremo.

No debes reiniciar ni modificar componentes críticos sin evidencia. Los recursos base saludables de prácticas anteriores —`cka-net/web-net`, `cka-net/net-debug`, `cka-storage/data-retain` y `cka-storage/writer`— deben conservarse.

## Objetivos de aprendizaje

Al finalizar la práctica, podrás:

- [ ] Aplicar una secuencia estructurada de diagnóstico basada en estado global, eventos, descripciones y logs.
- [ ] Recuperar un nodo `NotReady` comprobando kubelet, containerd y las condiciones del nodo.
- [ ] Diagnosticar un Pod `Pending` causado por un taint no tolerado y aplicar la corrección mínima.
- [ ] Restaurar la resolución DNS de CoreDNS y reparar la relación entre un Service y sus EndpointSlices.
- [ ] Corregir una referencia PVC errónea y validar que un workload puede leer datos persistentes.
- [ ] Documentar evidencia técnica reproducible, causa raíz, corrección y validación posterior.

## Prerrequisitos

### Conocimientos requeridos

- Interpretación de `kubectl get`, `kubectl describe`, eventos y logs.
- Identificación de estados `NotReady`, `Pending`, `ContainerCreating` y `Running`.
- Uso de taints, tolerations, `nodeSelector`, Services y EndpointSlices.
- Conceptos de StorageClass, PVC, PV, montaje de volúmenes y política de reclamación.
- Diagnóstico básico de kubelet, containerd y CoreDNS.

### Accesos requeridos

- Acceso `cluster-admin` mediante `kubectl` 1.31.6.
- Acceso SSH con `sudo` a `cp1`, `worker1` y `worker2`.
- Archivo `kubeconfig` funcional para el endpoint `https://10.10.10.10:6443`.
- Respaldo de CoreDNS creado en la Práctica 6, esperado como ConfigMap `coredns-corefile-backup` en `kube-system`.
- Recursos funcionales de las prácticas anteriores:

```text
Namespace cka-net:
  - Service web-net
  - Deployment web-net
  - Deployment net-debug

Namespace cka-storage:
  - StorageClass lab-local-retain
  - PVC data-retain
  - Deployment writer
```

## Entorno de laboratorio

### Topología

| Nodo | Dirección IP | Función |
|---|---:|---|
| `cp1` | `10.10.10.10/24` | Control plane |
| `worker1` | `10.10.10.11/24` | Worker |
| `worker2` | `10.10.10.12/24` | Worker |

### Componentes relevantes

| Componente | Versión o configuración esperada |
|---|---|
| Kubernetes | `1.31.6-1.1` |
| Runtime | containerd `1.7.24-1` |
| CNI | Calico `3.29.2` |
| DNS | CoreDNS `1.11.3` |
| Provisionador local | Rancher Local Path Provisioner `0.0.31` |
| Pod CIDR | `192.168.0.0/16` |
| Service CIDR | `10.96.0.0/12` |
| DNS de servicios | `10.96.0.10` |

### Comprobación inicial del entorno

Ejecuta estas comprobaciones antes de comenzar el escenario:

```bash
kubectl config current-context
kubectl cluster-info
kubectl get nodes -o wide
kubectl get ns
kubectl get pods -A
```

Comprueba los recursos base:

```bash
kubectl get svc,deploy,pods -n cka-net
kubectl get sc
kubectl get pvc,pv -n cka-storage
kubectl get deploy,pods -n cka-storage
kubectl get configmap coredns-corefile-backup -n kube-system
```

> Si el respaldo tiene otro nombre, identifica el ConfigMap correcto antes de continuar y define la variable `BACKUP_CM` con ese nombre.

```bash
export BACKUP_CM=coredns-corefile-backup
kubectl get configmap "$BACKUP_CM" -n kube-system -o jsonpath='{.data.Corefile}' | head
```

### Preparación controlada de fallas para el instructor

> **Importante:** esta subsección la ejecuta el instructor o un script de laboratorio antes de que el estudiante inicie el diagnóstico. El estudiante debe recibir únicamente los síntomas iniciales y no esta secuencia de inyección.

Crear el namespace de recursos temporales y aplicar los workloads de falla:

```bash
kubectl create namespace cka-faults --dry-run=client -o yaml | kubectl apply -f -

cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scheduling-fault
  namespace: cka-faults
spec:
  replicas: 1
  selector:
    matchLabels:
      app: scheduling-fault
  template:
    metadata:
      labels:
        app: scheduling-fault
    spec:
      nodeSelector:
        kubernetes.io/hostname: worker1
      containers:
      - name: pause
        image: busybox:1.36.1
        command: ["sh", "-c", "sleep 3600"]
EOF

cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: writer-fault
  namespace: cka-storage
spec:
  replicas: 1
  selector:
    matchLabels:
      app: writer-fault
  template:
    metadata:
      labels:
        app: writer-fault
    spec:
      containers:
      - name: writer-fault
        image: busybox:1.36.1
        command: ["sh", "-c", "echo started; sleep 3600"]
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: data-retain-incorrecto
EOF
```

Aplicar las fallas reversibles:

```bash
# 1. Detener kubelet de worker2.
ssh <USUARIO>@worker2 'sudo systemctl stop kubelet'

# 2. Bloquear temporalmente el scheduling en worker1.
kubectl taint node worker1 lab08-scheduling=blocked:NoSchedule

# 3. Romper el selector del Service web-net.
kubectl patch service web-net -n cka-net \
  --type merge \
  -p '{"spec":{"selector":{"app":"web-net-fault"}}}'

# 4. Sustituir temporalmente la zona Kubernetes en el Corefile.
kubectl get configmap coredns -n kube-system \
  -o jsonpath='{.data.Corefile}' > /tmp/Corefile.lab08.original

sed '0,/kubernetes cluster\.local/s//kubernetes lab08.invalid/' \
  /tmp/Corefile.lab08.original > /tmp/Corefile.lab08.bad

kubectl create configmap coredns -n kube-system \
  --from-file=Corefile=/tmp/Corefile.lab08.bad \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl rollout restart deployment/coredns -n kube-system
kubectl rollout status deployment/coredns -n kube-system --timeout=120s
```

## Procedimiento paso a paso

### Paso 1. Confirmar contexto y establecer la línea base

**Objetivo:** confirmar que estás conectado al clúster correcto, identificar el alcance inicial y preservar evidencia antes de realizar cambios.

**Instrucciones:**

1. Crea un directorio local para guardar evidencia de la práctica.

   ```bash
   export LABDIR="$HOME/lab08-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$LABDIR"
   echo "$LABDIR"
   ```

2. Registra el contexto, nodos, Pods y eventos recientes.

   ```bash
   kubectl config current-context | tee "$LABDIR/contexto.txt"
   kubectl get nodes -o wide | tee "$LABDIR/nodos-inicial.txt"
   kubectl get pods -A -o wide | tee "$LABDIR/pods-inicial.txt"
   kubectl get events -A --sort-by=.lastTimestamp | tail -n 80 \
     | tee "$LABDIR/eventos-iniciales.txt"
   ```

3. Comprueba el estado de los recursos de red y almacenamiento base.

   ```bash
   kubectl get svc,deploy,pods -n cka-net -o wide \
     | tee "$LABDIR/cka-net-inicial.txt"

   kubectl get pvc,pv -n cka-storage \
     | tee "$LABDIR/storage-inicial.txt"

   kubectl get deploy,pods -n cka-storage -o wide \
     | tee "$LABDIR/writer-inicial.txt"
   ```

**Resultado esperado:**

- El API Server responde.
- Al menos un nodo puede aparecer como `NotReady`.
- Puede haber Pods `Pending`, `ContainerCreating` o no listos.
- Los eventos muestran evidencias de scheduling, montaje o conectividad.
- `data-retain` debe permanecer `Bound`; una falla de workload no implica necesariamente una falla del PVC.

**Verificación:**

```bash
kubectl get nodes
kubectl get pods -A --field-selector=status.phase!=Succeeded
kubectl get events -A --sort-by=.lastTimestamp | tail -n 30
```

Clasifica cada síntoma antes de corregirlo:

| Síntoma | Clasificación inicial |
|---|---|
| Nodo `NotReady` | Nodo, kubelet o runtime |
| Pod `Pending` | Scheduling, taints, selector, recursos o PVC |
| Fallo de `nslookup` | DNS, CoreDNS, red de Pod o configuración DNS |
| Service sin endpoints | Selector, etiquetas, readiness o EndpointSlice |
| Pod con error de volumen | PVC, PV, StorageClass, montaje o referencia de claim |

---

### Paso 2. Diagnosticar y recuperar el nodo `worker2`

**Objetivo:** demostrar que el estado `NotReady` es un síntoma y confirmar si la causa está en kubelet, containerd o la conectividad local del nodo.

**Instrucciones:**

1. Inspecciona las condiciones y eventos de `worker2`.

   ```bash
   kubectl describe node worker2 | tee "$LABDIR/describe-worker2-antes.txt"

   kubectl get node worker2 \
     -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"; "}{.reason}{"; "}{.message}{"\n"}{end}'
   ```

2. Observa los taints automáticos asociados a un nodo no disponible.

   ```bash
   kubectl get node worker2 -o jsonpath='{.spec.taints}{"\n"}'
   ```

3. Conéctate a `worker2` y consulta el estado de kubelet y containerd.

   ```bash
   ssh <USUARIO>@worker2
   ```

   En `worker2`, ejecuta:

   ```bash
   sudo systemctl status kubelet --no-pager
   sudo systemctl status containerd --no-pager
   sudo journalctl -u kubelet -n 80 --no-pager
   sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock ps -a
   ```

4. Formula la hipótesis. Si containerd está activo pero kubelet está detenido, la corrección mínima es iniciar kubelet; no reinicies todo el nodo.

   ```bash
   sudo systemctl start kubelet
   sudo systemctl enable kubelet
   sudo systemctl is-active kubelet
   sudo systemctl is-active containerd
   exit
   ```

5. Espera la recuperación desde la estación de administración.

   ```bash
   kubectl wait --for=condition=Ready node/worker2 --timeout=180s
   kubectl get nodes -o wide
   ```

**Resultado esperado:**

- Antes de la corrección, `worker2` presenta condiciones como `Ready=False` o `Ready=Unknown`.
- En el nodo, `kubelet` aparece como `inactive` o `failed`, mientras que containerd puede seguir `active`.
- Tras iniciar kubelet, el nodo vuelve a `Ready`.

**Verificación:**

```bash
kubectl describe node worker2 | tail -n 40
kubectl get node worker2 \
  -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}Ready={.status} Reason={.reason}{"\n"}{end}'

ssh <USUARIO>@worker2 \
  'sudo systemctl is-active kubelet && sudo systemctl is-active containerd'
```

Guarda la evidencia posterior:

```bash
kubectl describe node worker2 > "$LABDIR/describe-worker2-despues.txt"
```

---

### Paso 3. Resolver el bloqueo de scheduling

**Objetivo:** identificar un Pod `Pending` debido a un taint no tolerado y eliminar únicamente la restricción temporal de laboratorio.

**Instrucciones:**

1. Examina el Deployment y sus Pods.

   ```bash
   kubectl get deployment,pods -n cka-faults -o wide
   kubectl get events -n cka-faults --sort-by=.lastTimestamp
   ```

2. Describe el Pod `Pending`.

   ```bash
   POD_SCHED=$(kubectl get pods -n cka-faults \
     -l app=scheduling-fault \
     -o jsonpath='{.items[0].metadata.name}')

   kubectl describe pod "$POD_SCHED" -n cka-faults \
     | tee "$LABDIR/describe-scheduling-fault.txt"
   ```

3. Identifica en los eventos el mensaje de `FailedScheduling`. Debe indicar una combinación similar a:

   ```text
   0/3 nodes are available: ... node(s) had untolerated taint ...
   ```

4. Revisa el selector del Pod, los nodos y los taints de `worker1`.

   ```bash
   kubectl get deployment scheduling-fault -n cka-faults -o yaml \
     | sed -n '/nodeSelector:/,/containers:/p'

   kubectl get nodes --show-labels
   kubectl describe node worker1 | sed -n '/Taints:/,/Unschedulable:/p'
   ```

5. Confirma que el taint corresponde a una falla temporal del laboratorio y elimínalo sin afectar otros taints legítimos.

   ```bash
   kubectl taint node worker1 lab08-scheduling=blocked:NoSchedule-
   ```

6. Espera a que el Pod sea programado.

   ```bash
   kubectl rollout status deployment/scheduling-fault \
     -n cka-faults --timeout=180s

   kubectl get pods -n cka-faults -o wide
   ```

**Resultado esperado:**

- El Pod de `scheduling-fault` estaba `Pending`.
- Los eventos indican que `worker1` tenía un taint no tolerado.
- Al retirar exclusivamente `lab08-scheduling=blocked:NoSchedule`, el Pod pasa a `Running`.

**Verificación:**

```bash
kubectl get pod -n cka-faults -l app=scheduling-fault \
  -o jsonpath='{range .items[*]}{.metadata.name}{" phase="}{.status.phase}{" ready="}{.status.containerStatuses[0].ready}{" node="}{.spec.nodeName}{"\n"}{end}'

kubectl describe node worker1 | grep -A2 '^Taints:'
```

> No agregues una toleration al Deployment si el objetivo es remover un taint temporal aplicado por error. La corrección mínima y coherente con el escenario es quitar solo el taint `lab08-scheduling`.

---

### Paso 4. Diagnosticar CoreDNS y restaurar la resolución de servicios

**Objetivo:** comprobar que la falla DNS está en CoreDNS y restaurar el `Corefile` desde el respaldo de la Práctica 6.

**Instrucciones:**

1. Comprueba el estado de CoreDNS y consulta sus logs.

   ```bash
   kubectl get deployment,pods -n kube-system -l k8s-app=kube-dns -o wide

   kubectl logs deployment/coredns -n kube-system --tail=100 \
     | tee "$LABDIR/coredns-logs-antes.txt"
   ```

2. Inspecciona el Corefile activo y compáralo con el respaldo.

   ```bash
   kubectl get configmap coredns -n kube-system \
     -o jsonpath='{.data.Corefile}' | tee "$LABDIR/Corefile-activo.txt"

   kubectl get configmap "$BACKUP_CM" -n kube-system \
     -o jsonpath='{.data.Corefile}' | tee "$LABDIR/Corefile-respaldo.txt"

   diff -u "$LABDIR/Corefile-respaldo.txt" "$LABDIR/Corefile-activo.txt" || true
   ```

3. Identifica una definición incorrecta de zona Kubernetes, por ejemplo:

   ```text
   kubernetes lab08.invalid
   ```

   La configuración esperada debe incluir la zona:

   ```text
   kubernetes cluster.local
   ```

4. Restaura el Corefile desde el respaldo. Extrae primero el contenido para evitar editar manualmente una configuración crítica.

   ```bash
   kubectl get configmap "$BACKUP_CM" -n kube-system \
     -o jsonpath='{.data.Corefile}' > /tmp/Corefile.restore.lab08

   kubectl create configmap coredns -n kube-system \
     --from-file=Corefile=/tmp/Corefile.restore.lab08 \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

5. Reinicia de forma controlada el Deployment de CoreDNS para asegurar que todas las réplicas cargan el Corefile restaurado.

   ```bash
   kubectl rollout restart deployment/coredns -n kube-system
   kubectl rollout status deployment/coredns -n kube-system --timeout=180s
   kubectl get pods -n kube-system -l k8s-app=kube-dns
   ```

6. Ejecuta pruebas DNS desde el Pod de diagnóstico existente.

   ```bash
   kubectl exec -n cka-net deployment/net-debug -- \
     nslookup kubernetes.default.svc.cluster.local

   kubectl exec -n cka-net deployment/net-debug -- \
     nslookup web-net.cka-net.svc.cluster.local
   ```

**Resultado esperado:**

- CoreDNS puede estar `Running` aunque responda incorrectamente si su zona Kubernetes es errónea.
- El `diff` muestra la diferencia entre el Corefile activo y el respaldo.
- Después de restaurar, ambos nombres DNS se resuelven a direcciones IP válidas.
- `kubernetes.default.svc.cluster.local` debe resolver hacia el Service `kubernetes` del namespace `default`.

**Verificación:**

```bash
kubectl get configmap coredns -n kube-system \
  -o jsonpath='{.data.Corefile}' | grep 'kubernetes cluster.local'

kubectl exec -n cka-net deployment/net-debug -- \
  nslookup kubernetes.default.svc.cluster.local

kubectl exec -n cka-net deployment/net-debug -- \
  nslookup web-net.cka-net.svc.cluster.local
```

---

### Paso 5. Reparar la cadena Service → EndpointSlice → Pod

**Objetivo:** identificar que un Service sin endpoints puede tener Pods saludables y que la causa puede ser un selector incorrecto.

**Instrucciones:**

1. Examina el Service, sus selectores, Pods y EndpointSlices.

   ```bash
   kubectl get service web-net -n cka-net -o yaml \
     | tee "$LABDIR/web-net-service-antes.yaml"

   kubectl get pods -n cka-net --show-labels
   kubectl get endpointslices -n cka-net \
     -l kubernetes.io/service-name=web-net -o yaml \
     | tee "$LABDIR/web-net-endpointslices-antes.yaml"
   ```

2. Consulta el selector actual del Service y las etiquetas de los Pods de aplicación.

   ```bash
   kubectl get service web-net -n cka-net \
     -o jsonpath='{.spec.selector}{"\n"}'

   kubectl get pods -n cka-net -l app=web-net \
     -o jsonpath='{range .items[*]}{.metadata.name}{" labels="}{.metadata.labels}{"\n"}{end}'
   ```

3. Determina si el selector del Service coincide con las etiquetas reales. En este escenario, el selector temporalmente incorrecto es:

   ```text
   app: web-net-fault
   ```

4. Restaura el selector correcto sin recrear el Service ni modificar los Pods.

   ```bash
   kubectl patch service web-net -n cka-net \
     --type merge \
     -p '{"spec":{"selector":{"app":"web-net"}}}'
   ```

5. Espera unos segundos y vuelve a inspeccionar los EndpointSlices.

   ```bash
   sleep 10

   kubectl get endpointslices -n cka-net \
     -l kubernetes.io/service-name=web-net -o wide

   kubectl get endpointslices -n cka-net \
     -l kubernetes.io/service-name=web-net -o yaml
   ```

6. Obtén el puerto del Service y realiza una prueba HTTP desde `net-debug`.

   ```bash
   export WEB_PORT=$(kubectl get service web-net -n cka-net \
     -o jsonpath='{.spec.ports[0].port}')

   echo "$WEB_PORT"

   kubectl exec -n cka-net deployment/net-debug -- \
     wget -qO- "http://web-net:${WEB_PORT}/"
   ```

**Resultado esperado:**

- Los Pods de `web-net` están disponibles, pero inicialmente el Service no tiene endpoints listos.
- El selector del Service no coincide con las etiquetas de los Pods.
- Después del parche, aparece al menos un EndpointSlice con una dirección y condición `ready: true`.
- La consulta HTTP a `web-net` devuelve una respuesta de la aplicación.

**Verificación:**

```bash
kubectl get service web-net -n cka-net \
  -o jsonpath='selector={.spec.selector}{"\n"}'

kubectl get endpointslices -n cka-net \
  -l kubernetes.io/service-name=web-net \
  -o jsonpath='{range .items[*].endpoints[*]}{.addresses}{" ready="}{.conditions.ready}{"\n"}{end}'

kubectl exec -n cka-net deployment/net-debug -- \
  nslookup web-net.cka-net.svc.cluster.local

kubectl exec -n cka-net deployment/net-debug -- \
  wget -qO- "http://web-net:${WEB_PORT}/"
```

---

### Paso 6. Corregir una referencia PVC errónea

**Objetivo:** diferenciar un PVC saludable de un workload que no puede iniciarse porque referencia un nombre de PVC inexistente.

**Instrucciones:**

1. Revisa el estado del PVC persistente base y del Deployment de falla.

   ```bash
   kubectl get storageclass
   kubectl get pvc,pv -n cka-storage
   kubectl get deployment,pods -n cka-storage -o wide
   kubectl get events -n cka-storage --sort-by=.lastTimestamp
   ```

2. Describe el Pod creado por `writer-fault`.

   ```bash
   POD_STORAGE=$(kubectl get pods -n cka-storage \
     -l app=writer-fault \
     -o jsonpath='{.items[0].metadata.name}')

   kubectl describe pod "$POD_STORAGE" -n cka-storage \
     | tee "$LABDIR/describe-writer-fault.txt"
   ```

3. Inspecciona la referencia de volumen del Deployment y compara el nombre del claim con los PVC disponibles.

   ```bash
   kubectl get deployment writer-fault -n cka-storage \
     -o jsonpath='{.spec.template.spec.volumes[0].persistentVolumeClaim.claimName}{"\n"}'

   kubectl get pvc -n cka-storage
   ```

4. Confirma que el PVC correcto es `data-retain` y que está enlazado.

   ```bash
   kubectl get pvc data-retain -n cka-storage -o wide
   kubectl describe pvc data-retain -n cka-storage
   ```

5. Corrige únicamente el campo `claimName` del Deployment de falla.

   ```bash
   kubectl patch deployment writer-fault -n cka-storage \
     --type='json' \
     -p='[
       {
         "op":"replace",
         "path":"/spec/template/spec/volumes/0/persistentVolumeClaim/claimName",
         "value":"data-retain"
       }
     ]'
   ```

6. Espera la creación del nuevo Pod y valida el montaje.

   ```bash
   kubectl rollout status deployment/writer-fault \
     -n cka-storage --timeout=180s

   kubectl get pods -n cka-storage -l app=writer-fault -o wide

   kubectl exec -n cka-storage deployment/writer-fault -- \
     sh -c 'mount | grep " /data " || true; ls -l /data; cat /data/lab-state.txt'
   ```

7. Valida también el workload persistente base. No debe haber sido eliminado ni recreado innecesariamente.

   ```bash
   kubectl rollout status deployment/writer -n cka-storage --timeout=180s

   kubectl exec -n cka-storage deployment/writer -- \
     sh -c 'cat /data/lab-state.txt'
   ```

**Resultado esperado:**

- `data-retain` permanece en estado `Bound`.
- El Pod de `writer-fault` muestra un evento de montaje o referencia a un PVC inexistente.
- El problema no requiere crear un PVC nuevo, reprovisionar un PV ni cambiar la StorageClass.
- Tras corregir `claimName`, el Pod inicia y puede leer `/data/lab-state.txt`.
- El Deployment `writer` original conserva el mismo contenido persistente.

**Verificación:**

```bash
kubectl get pvc data-retain -n cka-storage \
  -o jsonpath='PVC={.metadata.name} phase={.status.phase} volume={.spec.volumeName}{"\n"}'

kubectl get pods -n cka-storage -l app=writer-fault
kubectl exec -n cka-storage deployment/writer-fault -- cat /data/lab-state.txt
kubectl exec -n cka-storage deployment/writer -- cat /data/lab-state.txt
```

---

### Paso 7. Elaborar el informe técnico de la intervención

**Objetivo:** producir evidencia reproducible y una conclusión técnica por cada incidencia encontrada.

**Instrucciones:**

1. Crea un archivo de informe en el directorio de evidencia.

   ```bash
   cat > "$LABDIR/informe-lab08.md" <<'EOF'
   # Informe técnico — Lab 08

   ## Contexto
   - Contexto kubectl:
   - Fecha y hora:
   - Operador:
   - Clúster:

   ## Incidencia 1: Nodo NotReady
   - Síntoma:
   - Alcance:
   - Hipótesis:
   - Evidencia:
   - Causa raíz:
   - Corrección mínima:
   - Validación:

   ## Incidencia 2: Scheduling
   - Síntoma:
   - Evidencia de eventos:
   - Causa raíz:
   - Corrección mínima:
   - Validación:

   ## Incidencia 3: DNS y CoreDNS
   - Síntoma:
   - Evidencia:
   - Diferencia en Corefile:
   - Causa raíz:
   - Corrección:
   - Validación DNS:

   ## Incidencia 4: Service y EndpointSlice
   - Síntoma:
   - Selector observado:
   - Etiquetas de Pods:
   - Causa raíz:
   - Corrección:
   - Validación HTTP y EndpointSlice:

   ## Incidencia 5: Almacenamiento
   - Síntoma:
   - Estado de PVC/PV:
   - Evidencia de evento:
   - Causa raíz:
   - Corrección:
   - Validación de persistencia:
   EOF
   ```

2. Añade al informe los comandos relevantes ejecutados y sus resultados resumidos.

3. Incluye la diferencia entre el Corefile alterado y el restaurado.

   ```bash
   diff -u "$LABDIR/Corefile-activo.txt" "$LABDIR/Corefile-respaldo.txt" \
     >> "$LABDIR/informe-lab08.md" || true
   ```

**Resultado esperado:**

- El informe contiene síntomas, hipótesis, evidencia, causa raíz, corrección mínima y validación.
- Las conclusiones distinguen síntomas de causas raíz.
- El informe no propone acciones destructivas que no fueron necesarias.

**Verificación:**

```bash
sed -n '1,220p' "$LABDIR/informe-lab08.md"
ls -lh "$LABDIR"
```

## Validación y pruebas finales

Ejecuta esta secuencia completa después de aplicar todas las correcciones.

```bash
# 1. Nodos y componentes principales.
kubectl get nodes -o wide
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide
kubectl get pods -n kube-system -l k8s-app=calico-node -o wide
kubectl get pods -n kube-system -l k8s-app=kube-proxy -o wide

# 2. Kubelet y containerd en el worker recuperado.
ssh <USUARIO>@worker2 \
  'sudo systemctl is-active kubelet && sudo systemctl is-active containerd'

# 3. Scheduling.
kubectl get deployment,pods -n cka-faults -o wide
kubectl get node worker1 -o jsonpath='{.spec.taints}{"\n"}'

# 4. DNS interno y Service.
kubectl exec -n cka-net deployment/net-debug -- \
  nslookup kubernetes.default.svc.cluster.local

kubectl exec -n cka-net deployment/net-debug -- \
  nslookup web-net.cka-net.svc.cluster.local

export WEB_PORT=$(kubectl get service web-net -n cka-net \
  -o jsonpath='{.spec.ports[0].port}')

kubectl exec -n cka-net deployment/net-debug -- \
  wget -qO- "http://web-net:${WEB_PORT}/"

# 5. EndpointSlices de web-net.
kubectl get endpointslices -n cka-net \
  -l kubernetes.io/service-name=web-net \
  -o jsonpath='{range .items[*].endpoints[*]}{.addresses}{" ready="}{.conditions.ready}{"\n"}{end}'

# 6. Persistencia.
kubectl get sc
kubectl get pvc,pv -n cka-storage
kubectl exec -n cka-storage deployment/writer -- \
  sh -c 'cat /data/lab-state.txt'
```

Criterios de aprobación:

| Comprobación | Resultado esperado |
|---|---|
| `worker2` | Estado `Ready` |
| kubelet en `worker2` | `active` |
| containerd en `worker2` | `active` |
| `scheduling-fault` | Pod `Running` y listo |
| CoreDNS | Réplicas disponibles y Corefile con `kubernetes cluster.local` |
| DNS de `kubernetes.default` | Resuelve correctamente |
| DNS de `web-net.cka-net` | Resuelve correctamente |
| `web-net` | EndpointSlice con endpoint `ready=true` |
| HTTP contra `web-net` | Respuesta satisfactoria |
| PVC `data-retain` | Estado `Bound` |
| `writer` | Puede leer `/data/lab-state.txt` |

## Troubleshooting

### Problema 1: CoreDNS no queda disponible después de restaurar el Corefile

**Síntomas:**

```text
kubectl rollout status deployment/coredns -n kube-system --timeout=180s
error: timed out waiting for the condition
```

Los Pods de CoreDNS pueden mostrar `CrashLoopBackOff` o errores de análisis de configuración.

**Causa probable:** el respaldo contiene un Corefile incompleto, se copió con caracteres dañados o se aplicó un archivo que no corresponde a la clave `Corefile`.

**Corrección:**

1. Consulta los logs y el estado de los Pods:

   ```bash
   kubectl get pods -n kube-system -l k8s-app=kube-dns
   kubectl logs -n kube-system -l k8s-app=kube-dns --tail=100
   ```

2. Comprueba que el ConfigMap de respaldo tiene una clave llamada `Corefile`:

   ```bash
   kubectl get configmap "$BACKUP_CM" -n kube-system -o yaml
   ```

3. Restaura nuevamente usando la extracción directa de la clave correcta:

   ```bash
   kubectl get configmap "$BACKUP_CM" -n kube-system \
     -o jsonpath='{.data.Corefile}' > /tmp/Corefile.restore.lab08

   kubectl create configmap coredns -n kube-system \
     --from-file=Corefile=/tmp/Corefile.restore.lab08 \
     --dry-run=client -o yaml | kubectl apply -f -

   kubectl rollout restart deployment/coredns -n kube-system
   kubectl rollout status deployment/coredns -n kube-system --timeout=180s
   ```

### Problema 2: `writer-fault` continúa sin iniciar tras corregir el nombre del PVC

**Síntomas:**

El PVC `data-retain` está `Bound`, pero el Pod sigue en `Pending`, `ContainerCreating` o muestra mensajes relacionados con montaje.

**Causa probable:** el Pod anterior aún no fue reemplazado por el Deployment, el claim sigue mal configurado en la plantilla, o existe una restricción de acceso local que requiere que el Pod se programe en el nodo compatible con el volumen.

**Corrección:**

1. Confirma el claim configurado en la plantilla:

   ```bash
   kubectl get deployment writer-fault -n cka-storage \
     -o jsonpath='{.spec.template.spec.volumes[0].persistentVolumeClaim.claimName}{"\n"}'
   ```

2. Elimina únicamente el Pod de falla para que el Deployment cree uno con la plantilla actualizada:

   ```bash
   kubectl delete pod -n cka-storage -l app=writer-fault
   kubectl rollout status deployment/writer-fault -n cka-storage --timeout=180s
   ```

3. Revisa eventos y la ubicación del PV si el problema continúa:

   ```bash
   kubectl get events -n cka-storage --sort-by=.lastTimestamp | tail -n 30
   kubectl describe pvc data-retain -n cka-storage
   kubectl describe pv "$(kubectl get pvc data-retain -n cka-storage -o jsonpath='{.spec.volumeName}')"
   ```

No elimines `data-retain` ni su PV para resolver este escenario: el objetivo es preservar el estado persistente existente.

## Limpieza

> La limpieza elimina exclusivamente recursos de falla. No elimines `web-net`, `net-debug`, `writer`, `data-retain`, la StorageClass `lab-local-retain`, el PV ni el respaldo de CoreDNS.

1. Elimina los Deployments temporales.

   ```bash
   kubectl delete deployment scheduling-fault -n cka-faults --ignore-not-found
   kubectl delete deployment writer-fault -n cka-storage --ignore-not-found
   ```

2. Elimina el namespace temporal.

   ```bash
   kubectl delete namespace cka-faults --ignore-not-found
   ```

3. Asegura que el taint temporal no exista.

   ```bash
   kubectl taint node worker1 lab08-scheduling=blocked:NoSchedule- 2>/dev/null || true
   ```

4. Asegura que kubelet está iniciado en `worker2`.

   ```bash
   ssh <USUARIO>@worker2 \
     'sudo systemctl start kubelet && sudo systemctl is-active kubelet'
   ```

5. Restaura CoreDNS desde el respaldo de la Práctica 6, incluso si ya parece funcional.

   ```bash
   kubectl get configmap "$BACKUP_CM" -n kube-system \
     -o jsonpath='{.data.Corefile}' > /tmp/Corefile.cleanup.lab08

   kubectl create configmap coredns -n kube-system \
     --from-file=Corefile=/tmp/Corefile.cleanup.lab08 \
     --dry-run=client -o yaml | kubectl apply -f -

   kubectl rollout restart deployment/coredns -n kube-system
   kubectl rollout status deployment/coredns -n kube-system --timeout=180s
   ```

6. Confirma el estado final de los recursos base.

   ```bash
   kubectl get nodes
   kubectl get svc,deploy,pods -n cka-net
   kubectl get pvc,pv -n cka-storage
   kubectl get deploy,pods -n cka-storage
   ```

## Resumen

En esta práctica aplicaste una metodología de troubleshooting orientada a CKA sobre fallas combinadas. Partiste de una observación global, utilizaste eventos, condiciones, descripciones y logs para clasificar problemas, y aplicaste correcciones mínimas y reversibles.

Las recuperaciones realizadas demuestran los siguientes principios operativos:

- Un nodo `NotReady` requiere validar kubelet, runtime y condiciones antes de reiniciar componentes innecesarios.
- Un Pod `Pending` debe analizarse mediante eventos del scheduler para distinguir taints, selectores, recursos y PVCs.
- CoreDNS puede estar en ejecución y, aun así, responder incorrectamente por una configuración errónea.
- Un Service depende de que su selector coincida con las etiquetas de Pods listos para generar EndpointSlices utilizables.
- Un PVC `Bound` no garantiza que un workload esté correctamente configurado: la referencia `claimName` debe ser exacta.
- La validación debe ser funcional y de extremo a extremo: estado de nodos, Pods listos, resolución DNS, endpoints, conectividad HTTP y lectura persistente.

### Recursos opcionales

- [Depuración de clústeres Kubernetes](https://kubernetes.io/docs/tasks/debug/debug-cluster/)
- [Depuración de Pods en ejecución](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [Documentación de CoreDNS en Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/coredns/)
- [Servicios, selectores y EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/service/)
- [Volúmenes persistentes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
