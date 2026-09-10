---
layout: lab
title: "Práctica 7: Diagnóstico de almacenamiento persistente y StorageClass"
permalink: /lab7/lab7/
images_base: /labs/lab7/img
duration: "50 minutos"
objective:
  - Diagnosticar y corregir problemas de almacenamiento persistente en Kubernetes mediante PersistentVolume, PersistentVolumeClaim, StorageClass, access modes, capacidad y node affinity.
prerequisites:
  - Haber completado la Práctica 6 y disponer del clúster CKA operativo.
  - Tener kubectl configurado con acceso administrativo.
  - Contar con al menos dos nodos worker en estado Ready.
  - Poder ejecutar comandos con privilegios sudo en los workers.
  - Trabajar desde Visual Studio Code utilizando Git Bash como terminal principal.
introduction:
  - En esta práctica establecerás primero una línea base funcional con PersistentVolume, PersistentVolumeClaim y StorageClass. Después resolverás escenarios de troubleshooting en los que un PVC permanece Pending, un volumen no satisface la capacidad o access mode solicitado y un Pod no puede programarse por la node affinity de un volumen local.
slug: lab7
lab_number: 7
final_result: >
  Al finalizar habrás validado el ciclo PV-PVC-Pod, interpretado estados Bound y Pending, diagnosticado incompatibilidades de StorageClass, capacidad, access modes y node affinity, y recuperado workloads con almacenamiento persistente aplicando cambios puntuales basados en evidencia.
notes:
  - Los volúmenes locales utilizados son exclusivamente para laboratorio y no representan almacenamiento compartido de producción.
  - Los PersistentVolumes son recursos de alcance de clúster; los PersistentVolumeClaims pertenecen a un namespace.
  - Un PVC solo se enlaza con un PV compatible en capacidad, access modes, StorageClass y restricciones de scheduling.
  - No elimines recursos antes de revisar su estado y eventos.
references:
  - text: Persistent Volumes
    url: https://kubernetes.io/docs/concepts/storage/persistent-volumes/
  - text: Storage Classes
    url: https://kubernetes.io/docs/concepts/storage/storage-classes/
prev: /lab6/lab6/
next: /lab8/lab8/
---

---

## 💾 Tarea 1. Establecer la línea base de almacenamiento — 7 min

### Tarea 1.1. Revisar recursos existentes

- {% include step_label.html %} Consulta las StorageClasses disponibles para identificar las clases de almacenamiento configuradas y su comportamiento de aprovisionamiento.

  > **Nota:** Una StorageClass define características de aprovisionamiento y binding. Un clúster de laboratorio puede no tener una clase predeterminada.
  {: .lab-note .info .compact}

  ```bash
  kubectl get storageclass
  ```

  > **Salida esperada:** Se muestran las StorageClasses existentes o una lista vacía.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta los PersistentVolumes para reconocer la capacidad disponible, su estado actual y la StorageClass asociada a cada volumen.

  > **Nota:** Los PV representan capacidad de almacenamiento disponible o asignada a nivel de clúster.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pv
  ```

  > **Salida esperada:** Se muestran los PV existentes o una lista vacía.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta los PersistentVolumeClaims de todos los namespaces para identificar solicitudes de almacenamiento y su estado de binding.

  > **Nota:** Los PVC representan solicitudes de almacenamiento realizadas por workloads dentro de un namespace.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pvc -A
  ```

  > **Salida esperada:** Se muestran los PVC existentes y su estado actual en los namespaces donde estén definidos.
  {: .lab-note .output .compact}

### Tarea 1.2. Preparar el namespace y seleccionar un worker

- {% include step_label.html %} Crea el namespace `storage-lab` para aislar los recursos de almacenamiento y mantener separados los escenarios de diagnóstico.

  > **Nota:** El namespace aislará los claims y Pods usados durante la práctica.
  {: .lab-note .info .compact}

  ```bash
  kubectl create namespace storage-lab
  ```

  > **Salida esperada:** Kubernetes confirma la creación del namespace `storage-lab`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Guarda el primer worker disponible en una variable para reutilizar su nombre al definir la afinidad del PersistentVolume local.

  > **Nota:** El PV local deberá asociarse al mismo nodo donde exista físicamente su directorio.
  {: .lab-note .info .compact}

  ```bash
  WORKER=$(kubectl get nodes     -l '!node-role.kubernetes.io/control-plane'     -o jsonpath='{.items[0].metadata.name}')
  ```


  > **Salida esperada:** La variable `WORKER` queda definida con el nombre de un nodo worker.
  {: .lab-note .output .compact}
- {% include step_label.html %} Confirma el worker seleccionado para asegurarte de que el volumen local se asociará al nodo correcto durante toda la práctica.

  > **Importante:** Anota este nodo; la node affinity del volumen dependerá de él.
  {: .lab-note .important .compact}

  ```bash
  echo "$WORKER"
  ```


  > **Salida esperada:** Se muestra el nombre del worker seleccionado.
  {: .lab-note .output .compact}

### Tarea 1.3. Preparar el directorio local

- {% include step_label.html %} Accede al worker seleccionado y crea `/mnt/cka-storage`, que funcionará como ruta física para el volumen local del laboratorio.

  > **Advertencia:** Este comando se ejecuta en el worker guardado en `$WORKER`, no en el control-plane.
  {: .lab-note .warning .compact}

  ```bash
  sudo mkdir -p /mnt/cka-storage
  ```


  > **Salida esperada:** El directorio `/mnt/cka-storage` queda creado en el worker seleccionado.
  {: .lab-note .output .compact}
- {% include step_label.html %} Ajusta los permisos del directorio para permitir que los Pods del laboratorio puedan leer y escribir sin bloqueos por permisos.

  > **Nota:** Los permisos amplios simplifican la práctica; en producción deben definirse permisos apropiados al workload.
  {: .lab-note .info .compact}

  ```bash
  sudo chmod 777 /mnt/cka-storage
  ```

  > **Salida esperada:** El comando termina sin errores y el directorio queda accesible para la práctica.
  {: .lab-note .output .compact}
- {% include step_label.html %} Verifica que la ruta local existe y conserva los permisos esperados antes de continuar con la definición del PersistentVolume.

  > **Nota:** Confirmar la existencia del path evita confundir un error de ruta con un problema de Kubernetes.
  {: .lab-note .info .compact}

  ```bash
  ls -ld /mnt/cka-storage
  ```

{% assign results = site.data.task-results[page.slug].results %}

  > **Salida esperada:** Se muestra `/mnt/cka-storage` con los permisos configurados.
  {: .lab-note .output .compact}

{% capture r1 %}{{ results[0] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r1 %}
{% include support-prompt.html task="tarea1" %}

---

## 🧱 Tarea 2. Crear StorageClass, PV, PVC y Pod — 7 min

### Tarea 2.1. Crear una StorageClass manual

- {% include step_label.html %} Regresa a Git Bash del **cka-control** y crea `storageclass.yaml` para definir una StorageClass manual sin aprovisionamiento dinámico.

  > **Nota:** `kubernetes.io/no-provisioner` indica que los PV se crearán manualmente.
  {: .lab-note .info .compact}

  ```bash
  cat > storageclass.yaml <<'EOF'
  apiVersion: storage.k8s.io/v1
  kind: StorageClass
  metadata:
    name: cka-local
  provisioner: kubernetes.io/no-provisioner
  volumeBindingMode: WaitForFirstConsumer
  EOF
  ```


  > **Salida esperada:** Se crea el archivo `storageclass.yaml` con la definición de `cka-local`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Aplica la StorageClass para registrar la clase `cka-local` y habilitar el comportamiento de binding definido en el manifiesto.

  > **Nota:** `WaitForFirstConsumer` permite considerar restricciones de scheduling antes del binding definitivo.
  {: .lab-note .info .compact}

  ```bash
  kubectl apply -f storageclass.yaml
  ```


  > **Salida esperada:** Kubernetes confirma la creación o configuración de `storageclass.storage.k8s.io/cka-local`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa las propiedades de `cka-local` para confirmar el provisioner configurado y el modo de binding esperado.

  > **Nota:** Verifica especialmente el provisioner y `VOLUMEBINDINGMODE`.
  {: .lab-note .info .compact}

  ```bash
  kubectl get storageclass cka-local
  ```


  > **Salida esperada:** Se observa `kubernetes.io/no-provisioner` y `WaitForFirstConsumer`.
  {: .lab-note .output .compact}

### Tarea 2.2. Crear el PersistentVolume

- {% include step_label.html %} Crea `pv.yaml` usando el worker seleccionado para asociar el volumen local con la ruta física y el nodo correctos.

  > **Importante:** La node affinity relaciona el PV con el nodo que contiene `/mnt/cka-storage`.
  {: .lab-note .important .compact}

  ```bash
  cat > pv.yaml <<EOF
  apiVersion: v1
  kind: PersistentVolume
  metadata:
    name: pv-cka-local
  spec:
    capacity:
      storage: 1Gi
    volumeMode: Filesystem
    accessModes:
      - ReadWriteOnce
    persistentVolumeReclaimPolicy: Retain
    storageClassName: cka-local
    local:
      path: /mnt/cka-storage
    nodeAffinity:
      required:
        nodeSelectorTerms:
          - matchExpressions:
              - key: kubernetes.io/hostname
                operator: In
                values:
                  - ${WORKER}
  EOF
  ```

  > **Salida esperada:** Se crea `pv.yaml` con 1Gi, `ReadWriteOnce`, la ruta local y la node affinity del worker.
  {: .lab-note .output .compact}

- {% include step_label.html %} Aplica el PersistentVolume para registrar 1Gi de almacenamiento local disponible con la StorageClass `cka-local`.

  > **Nota:** El volumen queda disponible para un claim compatible.
  {: .lab-note .info .compact}

  ```bash
  kubectl apply -f pv.yaml
  ```

  > **Salida esperada:** Kubernetes confirma la creación de `persistentvolume/pv-cka-local`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba el estado del PersistentVolume para confirmar que Kubernetes lo reconoce y que está disponible para un claim compatible.

  > **Nota:** Antes de tener consumidor puede aparecer `Available`.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pv pv-cka-local
  ```
 
  > **Salida esperada:** El PV aparece registrado y normalmente en estado `Available` antes del binding.
  {: .lab-note .output .compact}

### Tarea 2.3. Crear PVC y Pod consumidor

- {% include step_label.html %} Crea un PVC de 500Mi para solicitar almacenamiento compatible con la capacidad, access mode y StorageClass del PV creado.

  > **Nota:** La capacidad y `ReadWriteOnce` son compatibles con el PV de 1Gi.
  {: .lab-note .info .compact}

  ```bash
  cat > pvc.yaml <<'EOF'
  apiVersion: v1
  kind: PersistentVolumeClaim
  metadata:
    name: data-pvc
    namespace: storage-lab
  spec:
    accessModes:
      - ReadWriteOnce
    storageClassName: cka-local
    resources:
      requests:
        storage: 500Mi
  EOF
  ```
  ```bash
  kubectl apply -f pvc.yaml
  ```

  > **Salida esperada:** Se crea y aplica `data-pvc` con una solicitud de 500Mi y `ReadWriteOnce`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Crea `pod-storage.yaml` para montar el PVC en `/data` y comprobar que el Pod puede utilizar almacenamiento persistente.

  > **Nota:** El scheduler deberá seleccionar el nodo compatible con la affinity del volumen.
  {: .lab-note .info .compact}

  ```bash
  cat > pod-storage.yaml <<'EOF'
  apiVersion: v1
  kind: Pod
  metadata:
    name: storage-app
    namespace: storage-lab
  spec:
    containers:
      - name: app
        image: busybox:1.37
        command: ["sh","-c","echo cka-storage-ok > /data/status.txt; sleep 3600"]
        volumeMounts:
          - name: data
            mountPath: /data
    volumes:
      - name: data
        persistentVolumeClaim:
          claimName: data-pvc
  EOF
  ```
  ```bash
  kubectl apply -f pod-storage.yaml
  ```

  > **Salida esperada:** Se crea y aplica el Pod `storage-app` con el PVC montado en `/data`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Espera a que el Pod quede Ready y revisa el binding para confirmar la relación funcional entre PV, PVC y consumidor.

  > **Importante:** El estado funcional esperado es PVC `Bound`, PV `Bound` y Pod `Running`.
  {: .lab-note .important .compact}

  ```bash
  kubectl wait --for=condition=Ready pod/storage-app     -n storage-lab --timeout=90s
  ```
  ```bash
  kubectl get pv
  kubectl get pvc -n storage-lab
  ```


  > **Salida esperada:** El Pod queda `Ready` y el PV/PVC aparecen `Bound`.
  {: .lab-note .output .compact}

{% capture r2 %}{{ results[1] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r2 %}
{% include support-prompt.html task="tarea2" %}

---

## 🔍 Tarea 3. Construir el flujo de diagnóstico — 6 min

### Tarea 3.1. Inspeccionar el PVC

- {% include step_label.html %} Describe `data-pvc` para revisar estado, StorageClass, volumen enlazado y eventos relacionados con el proceso de binding.

  > **Nota:** `describe` reúne estado, StorageClass, volumen enlazado y eventos de binding.
  {: .lab-note .info .compact}

  ```bash
  kubectl describe pvc data-pvc -n storage-lab
  ```

  > **Salida esperada:** El PVC muestra estado `Bound`, StorageClass `cka-local` y referencia al PV asignado.
  {: .lab-note .output .compact}

- {% include step_label.html %} Obtén el nombre del PV asignado desde el PVC para identificar de forma directa qué volumen satisfizo la solicitud.

  > **Nota:** `spec.volumeName` identifica directamente el volumen reclamado.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pvc data-pvc -n storage-lab -o jsonpath='{.spec.volumeName}{"\n"}'
  ```

  > **Salida esperada:** Se muestra `pv-cka-local`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa los eventos del namespace para detectar mensajes de binding, scheduling o montaje relevantes para el diagnóstico.

  > **Nota:** Los eventos suelen explicar por qué un claim no enlaza o por qué un Pod no puede programarse.
  {: .lab-note .info .compact}

  ```bash
  kubectl get events -n storage-lab --sort-by='.lastTimestamp'
  ```

  > **Salida esperada:** Se muestran eventos recientes sin errores persistentes de binding o montaje.
  {: .lab-note .output .compact}

### Tarea 3.2. Inspeccionar el PV

- {% include step_label.html %} Describe el PersistentVolume para analizar capacidad, access mode, StorageClass, ruta local y restricciones de node affinity.

  > **Nota:** Relaciona capacidad, access mode, StorageClass, ruta local y node affinity.
  {: .lab-note .info .compact}

  ```bash
  kubectl describe pv pv-cka-local
  ```

  > **Salida esperada:** Se muestran capacidad, access mode, StorageClass, ruta local y node affinity del PV.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta la `claimRef` para identificar el namespace y PVC que poseen actualmente el PersistentVolume seleccionado.

  > **Nota:** `claimRef` muestra qué PVC posee actualmente el volumen.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pv pv-cka-local -o jsonpath='{.spec.claimRef.namespace}/{.spec.claimRef.name}{"\n"}'
  ```

  > **Salida esperada:** Se muestra `storage-lab/data-pvc`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta la reclaim policy para conocer qué ocurrirá con el volumen y sus datos cuando el claim deje de existir.

  > **Nota:** `Retain` conserva los datos después de liberar el claim.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pv pv-cka-local -o jsonpath='{.spec.persistentVolumeReclaimPolicy}{"\n"}'
  ```

  > **Salida esperada:** Se muestra `Retain`.
  {: .lab-note .output .compact}

### Tarea 3.3. Validar persistencia

- {% include step_label.html %} Lee el archivo guardado en el volumen para comprobar que el montaje es funcional y que los datos persisten dentro del PVC.

  > **Nota:** Esto confirma que el volumen está montado y accesible desde el contenedor.
  {: .lab-note .info .compact}

  ```bash
  kubectl exec -n storage-lab storage-app -- cat /data/status.txt
  ```

  > **Salida esperada:** `cka-storage-ok`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba en qué nodo se ejecuta el Pod para verificar que coincide con la node affinity definida por el volumen local.

  > **Nota:** Debe coincidir con el nodo de la affinity del PV.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pod storage-app -n storage-lab -o wide
  ```

  > **Salida esperada:** El Pod aparece ejecutándose en el worker asociado al volumen.
  {: .lab-note .output .compact}

- {% include step_label.html %} Conserva esta línea base antes del troubleshooting para comparar estados saludables contra los escenarios defectuosos posteriores.

  > **Importante:** A partir de ahora revisa siempre PVC, PV, Pod y eventos antes de corregir.
  {: .lab-note .important .compact}

  ```bash
  kubectl get pv
  ```
  ```bash
  kubectl get pvc -n storage-lab
  ```
  ```bash
  kubectl get pods -n storage-lab -o wide
  ```

  > **Salida esperada:** PV, PVC y Pods aparecen en estados saludables antes de iniciar los escenarios de fallo.
  {: .lab-note .output .compact}

{% capture r3 %}{{ results[2] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r3 %}
{% include support-prompt.html task="tarea3" %}

---

## 🧩 Tarea 4. Troubleshooting: StorageClass incompatible — 6 min

### Tarea 4.1. Introducir el fallo

- {% include step_label.html %} Crea un PVC que solicite `cka-fast` para provocar una incompatibilidad controlada entre el claim y la StorageClass disponible.

  > **Nota:** Esa StorageClass no corresponde con el PV creado para esta práctica.
  {: .lab-note .info .compact}

  ```bash
  cat > pvc-class-broken.yaml <<'EOF'
  apiVersion: v1
  kind: PersistentVolumeClaim
  metadata:
    name: class-broken
    namespace: storage-lab
  spec:
    accessModes:
      - ReadWriteOnce
    storageClassName: cka-fast
    resources:
      requests:
        storage: 200Mi
  EOF
  ```
  ```bash
  kubectl apply -f pvc-class-broken.yaml
  ```


  > **Salida esperada:** Se crea el PVC `class-broken` solicitando la StorageClass `cka-fast`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta el estado del PVC para observar cómo Kubernetes representa una solicitud válida que todavía no puede enlazarse.

  > **Importante:** No corrijas todavía. Primero identifica por qué el claim no puede satisfacerse.
  {: .lab-note .important .compact}

  ```bash
  kubectl get pvc class-broken -n storage-lab
  ```

  > **Salida esperada:** El PVC permanece `Pending`.
  {: .lab-note .output .compact}

### Tarea 4.2. Diagnosticar

- {% include step_label.html %} Describe el PVC para revisar los eventos y detectar por qué Kubernetes no encuentra almacenamiento compatible para la solicitud.

  > **Nota:** Revisa eventos relacionados con aprovisionamiento o ausencia de volúmenes compatibles.
  {: .lab-note .info .compact}

  ```bash
  kubectl describe pvc class-broken -n storage-lab
  ```

  > **Salida esperada:** Los eventos indican que no existe almacenamiento compatible con la solicitud actual.
  {: .lab-note .output .compact}

- {% include step_label.html %} Compara la StorageClass solicitada con las existentes para confirmar que el problema proviene de una clase no disponible.

  > **Nota:** El diagnóstico debe demostrar la diferencia entre `cka-fast` y `cka-local`.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pvc class-broken -n storage-lab -o jsonpath='{.spec.storageClassName}{"\n"}'
  ```
  ```bash
  kubectl get storageclass
  ```

  > **Salida esperada:** Se observa que el PVC solicita `cka-fast` y la clase disponible del laboratorio es `cka-local`.
  {: .lab-note .output .compact}

### Tarea 4.3. Corregir

- {% include step_label.html %} Elimina el claim defectuoso para recrearlo con una StorageClass compatible sin alterar otros recursos del escenario.

  > **Nota:** Lo recrearás con la StorageClass correcta.
  {: .lab-note .info .compact}

  ```bash
  kubectl delete pvc class-broken -n storage-lab
  ```

  > **Salida esperada:** Kubernetes confirma la eliminación de `class-broken`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Genera una versión corregida del manifiesto cambiando únicamente el nombre del PVC y la StorageClass incompatible.

  > **Nota:** La corrección modifica únicamente la causa identificada.
  {: .lab-note .info .compact}

  ```bash
  sed -e 's/name: class-broken/name: class-fixed/' -e 's/storageClassName: cka-fast/storageClassName: cka-local/' pvc-class-broken.yaml > pvc-class-fixed.yaml
  ```

  > **Salida esperada:** Se crea `pvc-class-fixed.yaml` con `storageClassName: cka-local`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Aplica el PVC corregido y revisa su estado para confirmar que la incompatibilidad de StorageClass fue resuelta.

  > **Nota:** Con `WaitForFirstConsumer` puede permanecer `Pending` mientras no exista un consumidor.
  {: .lab-note .info .compact}

  ```bash
  kubectl apply -f pvc-class-fixed.yaml
  ```
  ```bash
  kubectl get pvc class-fixed -n storage-lab
  ```

  > **Salida esperada:** El PVC `class-fixed` se crea; con `WaitForFirstConsumer` puede permanecer `Pending` sin consumidor.
  {: .lab-note .output .compact}

{% capture r4 %}{{ results[3] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r4 %}
{% include support-prompt.html task="tarea4" %}

---

## 📏 Tarea 5. Troubleshooting: capacidad insuficiente — 6 min

### Tarea 5.1. Crear un PV pequeño

- {% include step_label.html %} En el worker crea `/mnt/cka-storage-small` como ruta física independiente para el volumen usado en la prueba de capacidad.

  > **Advertencia:** El directorio debe crearse en el mismo worker asociado al PV.
  {: .lab-note .warning .compact}

  ```bash
  sudo mkdir -p /mnt/cka-storage-small
  ```
  ```bash
  sudo chmod 777 /mnt/cka-storage-small
  ```


  > **Salida esperada:** El directorio `/mnt/cka-storage-small` queda creado y accesible en el worker.
  {: .lab-note .output .compact}

- {% include step_label.html %} Regresa a Git Bash y crea un PV de 300Mi para disponer de un volumen deliberadamente menor que la solicitud posterior.

  > **Nota:** Este volumen será insuficiente para un claim de 700Mi.
  {: .lab-note .info .compact}

  ```bash
  cat > pv-small.yaml <<EOF
  apiVersion: v1
  kind: PersistentVolume
  metadata:
    name: pv-small
  spec:
    capacity:
      storage: 300Mi
    volumeMode: Filesystem
    accessModes:
      - ReadWriteOnce
    persistentVolumeReclaimPolicy: Retain
    storageClassName: cka-local
    local:
      path: /mnt/cka-storage-small
    nodeAffinity:
      required:
        nodeSelectorTerms:
          - matchExpressions:
              - key: kubernetes.io/hostname
                operator: In
                values:
                  - ${WORKER}
  EOF
  ```
  ```bash
  kubectl apply -f pv-small.yaml
  ```

  > **Salida esperada:** Se crea y aplica `pv-small` con capacidad de 300Mi.
  {: .lab-note .output .compact}

### Tarea 5.2. Solicitar más capacidad

- {% include step_label.html %} Crea un PVC de 700Mi para provocar una incompatibilidad de capacidad frente al PersistentVolume de 300Mi disponible.

  > **Importante:** Kubernetes no debe enlazar un PV cuya capacidad es inferior a la solicitada.
  {: .lab-note .important .compact}

  ```bash
  cat > pvc-too-large.yaml <<'EOF'
  apiVersion: v1
  kind: PersistentVolumeClaim
  metadata:
    name: too-large
    namespace: storage-lab
  spec:
    accessModes:
      - ReadWriteOnce
    storageClassName: cka-local
    resources:
      requests:
        storage: 700Mi
  EOF
  ```
  ```bash
  kubectl apply -f pvc-too-large.yaml
  ```


  > **Salida esperada:** Se crea `too-large` solicitando 700Mi.
  {: .lab-note .output .compact}

- {% include step_label.html %} Crea un Pod consumidor para forzar a Kubernetes a intentar resolver el binding del PVC bajo `WaitForFirstConsumer`.

  > **Nota:** El consumidor obliga a Kubernetes a intentar resolver el binding.
  {: .lab-note .info .compact}

  ```bash
  kubectl run capacity-test --image=busybox:1.37 --restart=Never -n storage-lab \
    --overrides='{
      "spec": {
        "containers": [
          {
            "name": "capacity-test",
            "image": "busybox:1.37",
            "command": ["sleep", "3600"],
            "volumeMounts": [
              {
                "name": "data",
                "mountPath": "/data"
              }
            ]
          }
        ],
        "volumes": [
          {
            "name": "data",
            "persistentVolumeClaim": {
              "claimName": "too-large"
            }
          }
        ]
      }
    }'
  ```

  > **Salida esperada:** Se crea `capacity-test` para activar el intento de binding del claim.
  {: .lab-note .output .compact}

- {% include step_label.html %} Observa el estado del PVC y del Pod para identificar cómo una capacidad insuficiente afecta binding y scheduling.

  > **Nota:** El claim y el Pod deben permanecer pendientes mientras no exista capacidad suficiente.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pvc too-large -n storage-lab
  ```
  ```bash
  kubectl get pod capacity-test -n storage-lab
  ```

  > **Salida esperada:** El PVC permanece `Pending` y el Pod no llega a `Running`.
  {: .lab-note .output .compact}

### Tarea 5.3. Diagnosticar y corregir

- {% include step_label.html %} Describe el PVC y compara capacidades para demostrar con evidencia que la solicitud supera el tamaño del PV disponible.

  > **Nota:** La evidencia debe mostrar que 700Mi no puede satisfacerse con un PV de 300Mi.
  {: .lab-note .info .compact}

  ```bash
  kubectl describe pvc too-large -n storage-lab
  ```
  ```bash
  kubectl get pv
  ```

  > **Salida esperada:** Los eventos indican que no existe almacenamiento compatible con la solicitud actual.
  {: .lab-note .output .compact}

- {% include step_label.html %} Elimina el Pod y PVC defectuosos para recrear el escenario con una solicitud de capacidad compatible.

  > **Nota:** El escenario se recreará con una solicitud compatible.
  {: .lab-note .info .compact}

  ```bash
  kubectl delete pod capacity-test -n storage-lab
  ```
  ```bash
  kubectl delete pvc too-large -n storage-lab
  ```

  > **Salida esperada:** Kubernetes confirma la eliminación de `capacity-test` y `too-large`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Crea un claim corregido de 200Mi para demostrar que la reducción de capacidad permite una combinación compatible.

  > **Importante:** La corrección se basa en la capacidad disponible, no en reiniciar componentes.
  {: .lab-note .important .compact}

  ```bash
  sed -e 's/name: too-large/name: capacity-fixed/' -e 's/storage: 700Mi/storage: 200Mi/' pvc-too-large.yaml > pvc-capacity-fixed.yaml
  ```
  ```bash
  kubectl apply -f pvc-capacity-fixed.yaml
  ```

  > **Salida esperada:** Se crea `capacity-fixed` con una solicitud de 200Mi compatible con `pv-small`.
  {: .lab-note .output .compact}

{% capture r5 %}{{ results[4] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r5 %}
{% include support-prompt.html task="tarea5" %}

---

## 🔐 Tarea 6. Troubleshooting: access mode incompatible — 6 min

### Tarea 6.1. Introducir la incompatibilidad

- {% include step_label.html %} Crea un PVC que solicite `ReadWriteMany` para provocar una incompatibilidad con los PV `ReadWriteOnce` existentes.

  > **Nota:** Los PV del laboratorio ofrecen `ReadWriteOnce`.
  {: .lab-note .info .compact}

  ```bash
  cat > pvc-access-broken.yaml <<'EOF'
  apiVersion: v1
  kind: PersistentVolumeClaim
  metadata:
    name: access-broken
    namespace: storage-lab
  spec:
    accessModes:
      - ReadWriteMany
    storageClassName: cka-local
    resources:
      requests:
        storage: 100Mi
  EOF
  ```
  ```bash
  kubectl apply -f pvc-access-broken.yaml
  ```


  > **Salida esperada:** Se crea `access-broken` solicitando `ReadWriteMany`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta el estado del PVC para confirmar que la solicitud permanece sin enlazar mientras no exista un volumen compatible.

  > **Importante:** No modifiques los PV todavía; primero compara requisitos y capacidades.
  {: .lab-note .important .compact}

  ```bash
  kubectl get pvc access-broken -n storage-lab
  ```

  > **Salida esperada:** El PVC `access-broken` permanece `Pending`.
  {: .lab-note .output .compact}

### Tarea 6.2. Diagnosticar

- {% include step_label.html %} Consulta el access mode solicitado para identificar exactamente qué requisito de acceso está exigiendo el claim.

  > **Nota:** El claim declara explícitamente el tipo de acceso requerido.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pvc access-broken -n storage-lab -o jsonpath='{.spec.accessModes}{"\n"}'
  ```

  > **Salida esperada:** Se muestra `ReadWriteMany`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Compara los PV disponibles para verificar qué access modes ofrecen y localizar la diferencia con el PVC.

  > **Nota:** Un PV `ReadWriteOnce` no satisface un claim que exige `ReadWriteMany`.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pv -o custom-columns='NAME:.metadata.name,CAPACITY:.spec.capacity.storage,ACCESS:.spec.accessModes,CLASS:.spec.storageClassName,STATUS:.status.phase'
  ```

  > **Salida esperada:** Los PV disponibles muestran `ReadWriteOnce`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa los eventos del PVC para complementar el diagnóstico con mensajes generados por el controlador de almacenamiento.

  > **Nota:** Los eventos complementan la evidencia del mismatch.
  {: .lab-note .info .compact}

  ```bash
  kubectl describe pvc access-broken -n storage-lab
  ```

  > **Salida esperada:** Los eventos muestran que no existe un volumen compatible con el modo solicitado.
  {: .lab-note .output .compact}

### Tarea 6.3. Corregir

- {% include step_label.html %} Elimina el PVC defectuoso para recrearlo con un access mode compatible sin modificar los PersistentVolumes existentes.

  > **Nota:** Lo recrearás con un access mode compatible.
  {: .lab-note .info .compact}

  ```bash
  kubectl delete pvc access-broken -n storage-lab
  ```

  > **Salida esperada:** Kubernetes confirma la eliminación de `access-broken`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Genera una versión `ReadWriteOnce` del PVC modificando únicamente el requisito que causó la incompatibilidad.

  > **Nota:** Se modifica únicamente el requisito incompatible.
  {: .lab-note .info .compact}

  ```bash
  sed -e 's/name: access-broken/name: access-fixed/' -e 's/ReadWriteMany/ReadWriteOnce/' pvc-access-broken.yaml > pvc-access-fixed.yaml
  ```

  > **Salida esperada:** Se crea `pvc-access-fixed.yaml` solicitando `ReadWriteOnce`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Aplica el claim corregido para confirmar que el access mode solicitado ahora coincide con los volúmenes disponibles.

  > **Nota:** El claim ya utiliza un modo ofrecido por los PV locales.
  {: .lab-note .info .compact}

  ```bash
  kubectl apply -f pvc-access-fixed.yaml
  ```

  > **Salida esperada:** Se muestra `ReadWriteMany`.
  {: .lab-note .output .compact}

{% capture r6 %}{{ results[5] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r6 %}
{% include support-prompt.html task="tarea6" %}

---

## 🧭 Tarea 7. Troubleshooting: conflicto de node affinity — 6 min

### Tarea 7.1. Seleccionar otro worker

- {% include step_label.html %} Lista los workers disponibles para identificar un segundo nodo y preparar un conflicto controlado de node affinity.

  > **Nota:** Este escenario necesita un nodo diferente del que contiene el volumen local.
  {: .lab-note .info .compact}

  ```bash
  kubectl get nodes -l '!node-role.kubernetes.io/control-plane' -o custom-columns='NAME:.metadata.name'
  ```

  > **Salida esperada:** Se muestran al menos dos workers disponibles.
  {: .lab-note .output .compact}

- {% include step_label.html %} Guarda un worker distinto del asociado al PV para forzar un conflicto entre el Pod y la afinidad del volumen.

  > **Importante:** `$OTHER_WORKER` debe ser diferente de `$WORKER`.
  {: .lab-note .important .compact}

  ```bash
  WORKER=$(kubectl get pv pv-cka-local \
    -o jsonpath='{.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]}')
  ``` 
  ```bash
  OTHER_WORKER=$(kubectl get nodes \
    -l '!node-role.kubernetes.io/control-plane' \
    -o jsonpath='{.items[*].metadata.name}' \
    | tr ' ' '\n' \
    | grep -v "^${WORKER}$" \
    | head -n1)
  ```

  > **Salida esperada:** La variable `OTHER_WORKER` queda definida con un worker diferente de `$WORKER`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Confirma ambos nombres de worker para verificar que el nodo del volumen y el nodo forzado son realmente diferentes.

  > **Nota:** Si ambos nombres son iguales, no continúes porque no se producirá el conflicto esperado.
  {: .lab-note .info .compact}

  ```bash
  echo "PV node: $WORKER"
  ```
  ```bash
  echo "Forced node: $OTHER_WORKER"
  ```

  > **Salida esperada:** Se muestran dos nombres de worker distintos.
  {: .lab-note .output .compact}

### Tarea 7.2. Provocar el conflicto

- {% include step_label.html %} Crea un Pod que use `data-pvc` pero fuerce el segundo worker para provocar un conflicto real con la node affinity del PV.

  > **Advertencia:** El Pod será intencionalmente incompatible con la node affinity del PV.
  {: .lab-note .warning .compact}

  ```bash
  cat > pod-node-broken.yaml <<EOF
  apiVersion: v1
  kind: Pod
  metadata:
    name: node-broken
    namespace: storage-lab
  spec:
    nodeSelector:
      kubernetes.io/hostname: ${OTHER_WORKER}
    containers:
      - name: app
        image: busybox:1.37
        command: ["sleep","3600"]
        volumeMounts:
          - name: data
            mountPath: /data
    volumes:
      - name: data
        persistentVolumeClaim:
          claimName: data-pvc
  EOF
  ```
  ```bash
  kubectl apply -f pod-node-broken.yaml
  ```

  > **Salida esperada:** Se crea `node-broken` utilizando `data-pvc` y forzando el nodo alterno.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta el estado del Pod para observar cómo el scheduler mantiene `Pending` una carga incompatible con el volumen.

  > **Nota:** El scheduler no debe ubicarlo en un nodo incompatible con el volumen local.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pod node-broken -n storage-lab -o wide
  ```

  > **Salida esperada:** El Pod `node-broken` permanece `Pending`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Describe el Pod para revisar los eventos del scheduler y localizar evidencia específica del conflicto de node affinity.

  > **Importante:** Busca evidencia de conflicto con la node affinity del volumen.
  {: .lab-note .important .compact}

  ```bash
  kubectl describe pod node-broken -n storage-lab
  ```

  > **Salida esperada:** Los eventos del scheduler muestran un conflicto con la node affinity del volumen.
  {: .lab-note .output .compact}

### Tarea 7.3. Corregir

- {% include step_label.html %} Elimina el Pod defectuoso para recrearlo sin la restricción de nodo que impide utilizar el volumen local.

  > **Nota:** Se recreará sin forzar un nodo incompatible.
  {: .lab-note .info .compact}

  ```bash
  kubectl delete pod node-broken -n storage-lab
  ```

  > **Salida esperada:** Kubernetes confirma la eliminación de `node-broken`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Crea una versión sin `nodeSelector` para permitir que el scheduler elija el nodo compatible con la affinity del PV.

  > **Nota:** El scheduler podrá seleccionar el nodo que satisface la affinity del PV.
  {: .lab-note .info .compact}

  ```bash
  cat > pod-node-fixed.yaml <<'EOF'
  apiVersion: v1
  kind: Pod
  metadata:
    name: node-fixed
    namespace: storage-lab
  spec:
    containers:
      - name: app
        image: busybox:1.37
        command: ["sleep","3600"]
        volumeMounts:
          - name: data
            mountPath: /data
    volumes:
      - name: data
        persistentVolumeClaim:
          claimName: data-pvc
  EOF
  ```
  ```bash
  kubectl apply -f pod-node-fixed.yaml
  ```

  > **Salida esperada:** Se crea y aplica `node-fixed` sin una restricción manual de nodo.
  {: .lab-note .output .compact}

- {% include step_label.html %} Espera a que el Pod quede Ready y confirma que fue programado en el mismo worker asociado al volumen local.

  > **Nota:** El Pod debe terminar ejecutándose en el worker asociado al volumen.
  {: .lab-note .info .compact}

  ```bash
  kubectl wait --for=condition=Ready pod/node-fixed -n storage-lab --timeout=90s
  ```

  ```bash
  kubectl get pod node-fixed -n storage-lab -o wide
  ```


  > **Salida esperada:** El Pod queda `Ready` y el PV/PVC aparecen `Bound`.
  {: .lab-note .output .compact}

{% capture r7 %}{{ results[6] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r7 %}
{% include support-prompt.html task="tarea7" %}

---

## ✅ Tarea 8. Validar recuperación y limpiar — 6 min

### Tarea 8.1. Confirmar persistencia

- {% include step_label.html %} Lee nuevamente el archivo desde `storage-app` para confirmar que los escenarios de troubleshooting no alteraron los datos.

  > **Nota:** Los escenarios de troubleshooting no deben alterar el contenido persistente original.
  {: .lab-note .info .compact}

  ```bash
  kubectl exec -n storage-lab storage-app -- cat /data/status.txt
  ```

  > **Salida esperada:** `cka-storage-ok`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Lee el mismo archivo desde `node-fixed` para comprobar que ambos Pods observan el contenido persistente del mismo PVC.

  > **Nota:** Ambos Pods utilizan el mismo PVC y deben observar el mismo contenido.
  {: .lab-note .info .compact}

  ```bash
  kubectl exec -n storage-lab node-fixed -- cat /data/status.txt
  ```

  > **Salida esperada:** `cka-storage-ok`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa los estados finales de PV y PVC para identificar qué recursos quedaron Bound, Pending, Available o Released.

  > **Importante:** Antes de limpiar distingue recursos `Bound`, `Pending`, `Available` o `Released`.
  {: .lab-note .important .compact}

  ```bash
  kubectl get pv
  ```
  ```bash
  kubectl get pvc -n storage-lab
  ```

  > **Salida esperada:** Se muestran los estados finales de los volúmenes y claims antes de la limpieza.
  {: .lab-note .output .compact}

### Tarea 8.2. Eliminar recursos Kubernetes

- {% include step_label.html %} Elimina el namespace `storage-lab` para retirar Pods y PVC sin eliminar todavía los PersistentVolumes de alcance de clúster.

  > **Advertencia:** Los PVC se eliminarán con el namespace, pero los PV son recursos de alcance de clúster.
  {: .lab-note .warning .compact}

  ```bash
  kubectl delete namespace storage-lab --wait=true
  ```

  > **Salida esperada:** Kubernetes confirma la eliminación del namespace `storage-lab`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa los PV después de eliminar los claims para observar el efecto de la política `Retain` sobre los volúmenes.

  > **Nota:** Con política `Retain`, un PV usado puede quedar `Released`.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pv
  ```

  > **Salida esperada:** Los PV usados pueden aparecer `Released` y los no usados pueden permanecer `Available`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Elimina los PersistentVolumes creados para la práctica una vez que ya revisaste su estado posterior a los claims.

  > **Nota:** Eliminar los objetos PV no borra automáticamente los directorios locales.
  {: .lab-note .info .compact}

  ```bash
  kubectl delete pv pv-cka-local pv-small
  ```

  > **Salida esperada:** Kubernetes confirma la eliminación de `pv-cka-local` y `pv-small`.
  {: .lab-note .output .compact}

### Tarea 8.3. Eliminar StorageClass y rutas locales

- {% include step_label.html %} Elimina la StorageClass `cka-local` para retirar la configuración de almacenamiento creada exclusivamente para este laboratorio.

  > **Nota:** La StorageClass deja de ser necesaria al finalizar el laboratorio.
  {: .lab-note .info .compact}

  ```bash
  kubectl delete storageclass cka-local
  ```

  > **Salida esperada:** Kubernetes confirma la eliminación de `cka-local`.
  {: .lab-note .output .compact}

- {% include step_label.html %} En el worker elimina únicamente las rutas creadas para la práctica después de confirmar que ya no serán utilizadas por ningún PV.

  > **Advertencia:** Verifica cuidadosamente las rutas antes de utilizar `rm -rf`.
  {: .lab-note .warning .compact}

  ```bash
  sudo rm -rf /mnt/cka-storage
  ```
  ```bash
  sudo rm -rf /mnt/cka-storage-small
  ```

  > **Salida esperada:** Los directorios locales del laboratorio quedan eliminados del worker.
  {: .lab-note .output .compact}

- {% include step_label.html %} Ejecuta una revisión final del clúster para confirmar que los nodos siguen saludables y que los recursos temporales fueron retirados.

  > **Nota:** La práctica termina cuando los recursos temporales fueron retirados y los nodos permanecen saludables.
  {: .lab-note .info .compact}

  ```bash
  kubectl get nodes
  ```
  ```bash
  kubectl get pv
  ```
  ```bash
  kubectl get storageclass
  ```

  > **Salida esperada:** Los nodos permanecen `Ready` y los recursos temporales de la práctica ya no existen.
  {: .lab-note .output .compact}

{% capture r8 %}{{ results[7] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r8 %}
{% include support-prompt.html task="tarea8" %}
