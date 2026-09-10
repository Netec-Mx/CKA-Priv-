---
layout: lab
title: "Práctica 8: Troubleshooting integral tipo CKA"
permalink: /lab8/lab8/
images_base: /labs/lab8/img
duration: "75 minutos"
objective:
  - Resolver incidentes integrales de Kubernetes mediante diagnóstico autónomo de nodos, scheduling, Services, almacenamiento y control plane.
prerequisites:
  - Haber completado la Práctica 7 y disponer del clúster CKA operativo.
  - Tener kubectl configurado con acceso administrativo desde cka-control.
  - Tener acceso SSH y privilegios sudo en cka-worker2 y cka-control.
  - Tener acceso a raw.githubusercontent.com desde los nodos del laboratorio.
  - No inspeccionar los archivos task2 a task6 antes de completar cada escenario.
introduction:
  - Esta práctica simula incidentes tipo CKA. Cada reto prepara una condición defectuosa mediante un archivo neutral y exige diagnosticarla sin instrucciones de solución. Corrige únicamente la causa necesaria y demuestra el resultado exacto solicitado antes de continuar.
slug: lab8
lab_number: 8
final_result: >
  Al finalizar habrás recuperado un nodo NotReady, corregido un workload sin scheduling, restaurado un Service sin endpoints, resuelto un problema de almacenamiento persistente y recuperado kube-scheduler, validando finalmente que el clúster vuelve a operar de forma estable.
notes:
  - Las Tareas 2 a 6 son escenarios de troubleshooting y los archivos de preparación no revelan la causa en el laboratorio.
  - No inspecciones los archivos task2 a task6 antes de resolver cada escenario; hacerlo elimina el valor diagnóstico del reto.
  - Corrige únicamente la causa identificada. No reinstales Kubernetes, no ejecutes kubeadm reset y no elimines nodos.
  - Cada paso indica explícitamente el nodo desde el cual debe ejecutarse para evitar ambigüedad entre cka-control y los workers.
references:
  - text: Troubleshooting Clusters
    url: https://kubernetes.io/docs/tasks/debug/debug-cluster/
  - text: Assigning Pods to Nodes
    url: https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/
  - text: Services
    url: https://kubernetes.io/docs/concepts/services-networking/service/
  - text: Persistent Volumes
    url: https://kubernetes.io/docs/concepts/storage/persistent-volumes/
  - text: Static Pods
    url: https://kubernetes.io/docs/concepts/workloads/pods/static-pods/
prev: /lab7/lab7/
next: /lab1/lab1/
---

---

<!-- Aquí comienzan las instrucciones paso a paso de la práctica -->

## 🔎 Tarea 1. Establecer una línea base rápida del clúster — 8 min

### Tarea 1.1. Confirmar salud general desde cka-control

- {% include step_label.html %} Desde `cka-control`, revisa todos los nodos para registrar su estado inicial antes de introducir los incidentes de troubleshooting.

  > **Nota:** Esta línea base permite distinguir una falla provocada por el escenario de un problema que ya existía antes de iniciar la práctica.
  {: .lab-note .info .compact}

  ```bash
  kubectl get nodes -o wide
  ```

  > **Salida esperada:** Todos los nodos del clúster aparecen en estado `Ready` antes de preparar la Tarea 2.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, revisa los Pods de `kube-system` para confirmar que los componentes críticos parten de un estado funcional.

  > **Nota:** Especialmente deben estar disponibles kube-apiserver, kube-controller-manager, kube-scheduler, etcd, CoreDNS y kube-proxy.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pods -n kube-system -o wide
  ```

  > **Salida esperada:** Los componentes esenciales están `Running` y no existen fallas críticas previas que invaliden los escenarios.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, confirma que el API Server responde correctamente antes de iniciar los retos que modificarán el entorno.

  > **Importante:** No continúes si esta validación falla, porque las tareas posteriores presuponen que el control plane comienza saludable.
  {: .lab-note .important .compact}

  ```bash
  kubectl get --raw='/readyz'
  ```

  > **Salida esperada:** El API Server responde `ok`.
  {: .lab-note .output .compact}

### Tarea 1.2. Registrar herramientas disponibles

- {% include step_label.html %} Desde `cka-control`, confirma la versión del cliente y servidor para conservar evidencia del entorno usado durante el ejercicio.

  > **Nota:** Registrar versiones ayuda a interpretar diferencias menores de salida sin convertirlas automáticamente en problemas del escenario.
  {: .lab-note .info .compact}

  ```bash
  kubectl version
  ```

  > **Salida esperada:** Se muestran las versiones del cliente y del servidor Kubernetes sin errores de conexión.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, verifica que `crictl` esté disponible porque el último escenario puede requerir diagnóstico local del runtime.

  > **Nota:** En incidentes del control plane no siempre basta con kubectl; los static Pods son administrados directamente por kubelet.
  {: .lab-note .info .compact}

  ```bash
  sudo crictl --version
  ```

  > **Salida esperada:** Se muestra una versión válida de `crictl`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, confirma que puedes acceder al archivo Raw usado para preparar el primer escenario.

  > **Importante:** Esta prueba valida conectividad HTTP únicamente; no abras el contenido del archivo neutral antes del reto.
  {: .lab-note .important .compact}

  ```bash
  curl -I https://raw.githubusercontent.com/Netec-Mx/CKA-Priv-/main/labs/lab8/scripts/task2.sh
  ```

  > **Salida esperada:** GitHub Raw responde con un estado HTTP exitoso después de publicar `task2.sh` en el repositorio.
  {: .lab-note .output .compact}

{% assign results = site.data.task-results[page.slug].results %}
{% capture r1 %}{{ results[0] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r1 %}
{% include support-prompt.html task="tarea1" %}

---

## 🧯 Tarea 2. Escenario CKA: recuperar un nodo NotReady — 11 min

### Tarea 2.1. Preparar el escenario

- {% include step_label.html %} Abre una nueva ventana de **Terminal**, conéctate por SSH a `cka-worker2` para ejecutar únicamente el archivo neutral que prepara este escenario.

  ```bash
  ssh worker2@192.168.10.102
  ```

  > **Salida esperada:** El prompt cambia a `control@cka-worker2`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-worker2`, descarga `task2.sh` directamente desde GitHub Raw sin consultar previamente su contenido.

  > **Nota:** El nombre neutral del archivo evita revelar qué componente será afectado durante la preparación del escenario.
  {: .lab-note .info .compact}

  ```bash
  curl -fsSLO https://raw.githubusercontent.com/Netec-Mx/CKA-Priv-/main/labs/lab8/scripts/task2.sh
  ```

  > **Salida esperada:** Se descarga `task2.sh` sin errores.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-worker2`, ejecuta el archivo de preparación y regresa al control-plane para iniciar el diagnóstico del incidente.

  > **Advertencia:** No ejecutes nuevamente el script durante el mismo intento; prepara una sola vez el estado defectuoso solicitado.
  {: .lab-note .warning .compact}

  ```bash
  chmod +x task2.sh
  ./task2.sh
  exit
  ```

  > **Salida esperada:** El script muestra `Escenario preparado.` y el prompt regresa a `control@cka-control`.
  {: .lab-note .output .compact}

### Tarea 2.2. Diagnosticar y recuperar

- {% include step_label.html %} Desde `cka-control`, identifica por qué `cka-worker2` deja de estar disponible y determina la causa antes de modificar el nodo.

  > **Importante:** Puedes utilizar herramientas de Kubernetes y del sistema, pero no reinstales paquetes, no elimines el nodo ni ejecutes `kubeadm join`.
  {: .lab-note .important .compact}

  > **Salida esperada:** Obtienes evidencia suficiente para explicar qué impide que `cka-worker2` reporte normalmente al control plane.
  {: .lab-note .output .compact}

- {% include step_label.html %} Corrige únicamente la causa identificada en `cka-worker2` utilizando la herramienta adecuada para recuperar el componente afectado.

  > **Nota:** El reto evalúa diagnóstico y recuperación; no se proporciona el comando correctivo ni el componente que debes intervenir.
  {: .lab-note .info .compact}

  > **Salida esperada:** El componente responsable queda operativo y deja de generar el error que provocó la pérdida del nodo.
  {: .lab-note .output .compact}

### Tarea 2.3. Validar el resultado exacto

- {% include step_label.html %} Desde `cka-control`, verifica el estado final del nodo y no continúes hasta que Kubernetes confirme su recuperación completa.

  > **Importante:** La tarea no termina; el nodo debe volver a reportar `Ready` al control plane.
  {: .lab-note .important .compact}

  ```bash
  kubectl get node cka-worker2
  ```

  > **Salida esperada:** `cka-worker2` aparece en estado `Ready`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, comprueba que las condiciones del nodo ya no muestran una causa activa que impida su participación normal.

  > **Nota:** Esta validación evita considerar resuelto un incidente únicamente porque cambió temporalmente la columna `STATUS`.
  {: .lab-note .info .compact}

  ```bash
  kubectl describe node cka-worker2
  ```

  > **Salida esperada:** `Ready=True` y no existen eventos persistentes asociados con la causa corregida.
  {: .lab-note .output .compact}

{% capture r2 %}{{ results[1] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r2 %}
{% include support-prompt.html task="tarea2" %}

---

## 🧭 Tarea 3. Escenario CKA: workload sin scheduling — 10 min

### Tarea 3.1. Preparar el escenario

- {% include step_label.html %} Desde `cka-control`, aplica directamente `task3.yaml` desde GitHub Raw para crear el escenario de scheduling sin inspeccionarlo.

  ```bash
  kubectl apply -f https://raw.githubusercontent.com/Netec-Mx/CKA-Priv-/main/labs/lab8/scripts/task3.yaml
  ```

  > **Salida esperada:** Kubernetes crea `exam-scheduling` y el Deployment `reports` sin errores de sintaxis.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, observa únicamente el síntoma inicial del workload después de que Kubernetes haya creado sus recursos.

  > **Nota:** Un objeto puede crearse correctamente en el API Server y aun así ser incapaz de ejecutar sus Pods.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pods -n exam-scheduling
  ```

  > **Salida esperada:** Los Pods de `reports` no alcanzan el estado `Running`.
  {: .lab-note .output .compact}

### Tarea 3.2. Diagnosticar y recuperar

- {% include step_label.html %} Diagnostica por qué las dos réplicas de `reports` no pueden programarse y localiza la restricción exacta que impide el scheduling.

  > **Salida esperada:** Identificas mediante evidencia del clúster qué requisito del workload no puede ser satisfecho por los nodos disponibles.
  {: .lab-note .output .compact}

- {% include step_label.html %} Modifica únicamente lo necesario para que el Deployment pueda programar ambas réplicas utilizando nodos válidos del clúster.

  > **Nota:** Conserva `replicas: 2`, el nombre `reports` y el namespace `exam-scheduling` durante toda la recuperación.
  {: .lab-note .info .compact}

  > **Salida esperada:** El Deployment empieza a crear Pods que pueden ser asignados a nodos reales del clúster.
  {: .lab-note .output .compact}

### Tarea 3.3. Validar el resultado exacto

- {% include step_label.html %} Desde `cka-control`, espera la disponibilidad completa del Deployment para demostrar que el problema de scheduling quedó resuelto.

  > **Nota:** `rollout status` evita aceptar una solución parcial en la que solamente una de las réplicas pudo iniciar correctamente.
  {: .lab-note .info .compact}

  ```bash
  kubectl rollout status deployment/reports -n exam-scheduling --timeout=90s
  ```

  > **Salida esperada:** El rollout finaliza correctamente.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, confirma que las dos réplicas requeridas están ejecutándose y listas después de la corrección aplicada.

  ```bash
  kubectl get deployment reports -n exam-scheduling
  ```

  > **Salida esperada:** `READY` muestra `2/2` y `AVAILABLE` muestra `2`.
  {: .lab-note .output .compact}

{% capture r3 %}{{ results[2] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r3 %}
{% include support-prompt.html task="tarea3" %}

---

## 🌐 Tarea 4. Escenario CKA: Service sin acceso a la aplicación — 11 min

### Tarea 4.1. Preparar el escenario

- {% include step_label.html %} Desde `cka-control`, aplica `task4.yaml` directamente desde GitHub Raw para crear la aplicación y su Service defectuoso.

  ```bash
  kubectl apply -f https://raw.githubusercontent.com/Netec-Mx/CKA-Priv-/main/labs/lab8/scripts/task4.yaml
  ```

  > **Salida esperada:** Kubernetes crea `exam-network`, el Deployment `payments` y el Service `payments-svc`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, espera que los Pods estén disponibles antes de diagnosticar por qué la aplicación no responde mediante el Service.

  > **Nota:** Esto evita confundir un problema de inicialización del Deployment con el incidente de conectividad que debes resolver.
  {: .lab-note .info .compact}

  ```bash
  kubectl rollout status deployment/payments -n exam-network --timeout=90s
  ```

  > **Salida esperada:** El Deployment completa el rollout y mantiene dos Pods disponibles.
  {: .lab-note .output .compact}

### Tarea 4.2. Diagnosticar y recuperar

- {% include step_label.html %} Diagnostica por qué `payments-svc` no entrega tráfico hacia la aplicación aunque los Pods del Deployment estén saludables.

  > **Salida esperada:** Demuestras qué propiedad impide que `payments-svc` disponga de backends válidos.
  {: .lab-note .output .compact}

- {% include step_label.html %} Corrige únicamente el recurso responsable para que `payments-svc` vuelva a dirigir tráfico a los Pods existentes.

  > **Nota:** Conserva el nombre del Service, el puerto 80 y las dos réplicas del Deployment durante la recuperación.
  {: .lab-note .info .compact}

  > **Salida esperada:** El Service obtiene endpoints correspondientes a los Pods saludables de `payments`.
  {: .lab-note .output .compact}

### Tarea 4.3. Validar el resultado exacto

- {% include step_label.html %} Desde `cka-control`, comprueba que el Service cuenta con EndpointSlices que contienen direcciones backend después de la corrección.

  > **Nota:** Un Service existente no demuestra conectividad por sí solo; debe disponer de endpoints válidos para entregar tráfico.
  {: .lab-note .info .compact}

  ```bash
  kubectl get endpointslice -n exam-network -l kubernetes.io/service-name=payments-svc -o wide
  ```

  > **Salida esperada:** Se muestran direcciones correspondientes a los dos Pods del Deployment `payments`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, crea una solicitud temporal dentro del clúster para comprobar el acceso real mediante el nombre del Service.

  > **Importante:** Acceder directamente a una IP de Pod no demuestra que `payments-svc` haya sido reparado correctamente.
  {: .lab-note .important .compact}

  ```bash
  kubectl run service-check -n exam-network --image=curlimages/curl:8.16.0 --restart=Never --rm -i -- curl -sS --max-time 5 http://payments-svc
  ```

  > **Salida esperada:** La solicitud devuelve la página HTML de NGINX sin timeout ni error de resolución.
  {: .lab-note .output .compact}

{% capture r4 %}{{ results[3] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r4 %}
{% include support-prompt.html task="tarea4" %}

---

## 💾 Tarea 5. Escenario CKA: almacenamiento persistente no disponible — 11 min

### Tarea 5.1. Preparar el escenario

- {% include step_label.html %} Desde `cka-control`, aplica `task5.yaml` desde GitHub Raw para crear el escenario completo de almacenamiento sin inspeccionarlo.

  ```bash
  kubectl apply -f https://raw.githubusercontent.com/Netec-Mx/CKA-Priv-/main/labs/lab8/scripts/task5.yaml
  ```

  > **Salida esperada:** Kubernetes crea los objetos del escenario en `exam-storage` sin errores de validación del manifiesto.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, observa el estado inicial del Pod y del claim para registrar el síntoma antes de realizar cualquier cambio.

  > **Nota:** El hecho de que los objetos existan no implica que Kubernetes haya podido completar el binding del almacenamiento.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pod,pvc -n exam-storage
  ```

  > **Salida esperada:** `app-data` no queda `Bound` y `storage-api` no alcanza `Running`.
  {: .lab-note .output .compact}

### Tarea 5.2. Diagnosticar y recuperar

- {% include step_label.html %} Diagnostica por qué el claim `app-data` no puede utilizar el PersistentVolume preparado para este escenario de almacenamiento.

  > **Salida esperada:** Obtienes evidencia que explica la incompatibilidad entre el PVC y el almacenamiento disponible.
  {: .lab-note .output .compact}

- {% include step_label.html %} Corrige el PVC conservando el nombre `app-data`, una solicitud de 500Mi y el Pod `storage-api` como consumidor.

  > **Nota:** Si necesitas recrear el PVC por tratarse de un campo no modificable, conserva los requisitos funcionales indicados en el reto.
  {: .lab-note .info .compact}

  > **Salida esperada:** El PVC puede enlazarse con `lab8-pv` y el Pod comienza su proceso normal de creación.
  {: .lab-note .output .compact}

### Tarea 5.3. Validar el resultado exacto

- {% include step_label.html %} Desde `cka-control`, verifica que el claim está enlazado exactamente con el PV preparado para este escenario.

  > **Nota:** Esta comprobación demuestra que la corrección resolvió la compatibilidad y no sustituyó el diseño del reto.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pvc app-data -n exam-storage
  ```

  > **Salida esperada:** `app-data` aparece `Bound` y la columna `VOLUME` muestra `lab8-pv`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, espera que `storage-api` quede listo y comprueba el contenido escrito dentro del volumen montado.

  ```bash
  kubectl wait --for=condition=Ready pod/storage-api -n exam-storage --timeout=90s
  kubectl exec -n exam-storage storage-api -- cat /data/status.txt
  ```

  > **Salida esperada:** El Pod queda `Ready` y el archivo contiene exactamente `storage-ready`.
  {: .lab-note .output .compact}

{% capture r5 %}{{ results[4] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r5 %}
{% include support-prompt.html task="tarea5" %}

---

## ⚙️ Tarea 6. Escenario CKA: componente del control plane degradado — 14 min

### Tarea 6.1. Preparar el escenario

- {% include step_label.html %} Desde `cka-control`, descarga `task6.sh` desde GitHub Raw sin inspeccionarlo para preparar el último incidente técnico.

  > **Advertencia:** Este escenario modifica un componente del control plane; no ejecutes el script más de una vez ni lo uses en otro nodo.
  {: .lab-note .warning .compact}

  ```bash
  curl -fsSLO https://raw.githubusercontent.com/Netec-Mx/CKA-Priv-/main/labs/lab8/scripts/task6.sh
  ```

  > **Salida esperada:** Se descarga `task6.sh` sin errores.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, ejecuta una sola vez el archivo de preparación y conserva abierta esta sesión para realizar el diagnóstico local.

  > **Importante:** No abras el script; a partir de este punto identifica el componente afectado usando evidencia del clúster y del nodo.
  {: .lab-note .important .compact}

  ```bash
  chmod +x task6.sh
  ./task6.sh
  ```

  > **Salida esperada:** El script muestra `Escenario preparado.` y el shell permanece disponible en `cka-control`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, crea un Pod de prueba para observar el síntoma provocado por el incidente activo del control plane.

  > **Nota:** El API Server puede aceptar el objeto aunque el componente encargado de asignarlo a un nodo esté degradado.
  {: .lab-note .info .compact}

  ```bash
  kubectl run scheduler-check --image=nginx:1.29-alpine --restart=Never
  ```

  > **Salida esperada:** El Pod se crea como objeto, pero no alcanza `Running` mientras el incidente permanezca activo.
  {: .lab-note .output .compact}

### Tarea 6.2. Diagnosticar y recuperar

- {% include step_label.html %} Diagnostica qué componente del control plane impide que un Pod nuevo sea asignado a un nodo aunque el API Server responda.

  > **Importante:** Utiliza las herramientas necesarias, pero no reinicies todos los servicios ni restaures etcd para resolver este incidente.
  {: .lab-note .important .compact}

  > **Salida esperada:** Identificas el componente afectado y obtienes evidencia local que explica por qué no funciona normalmente.
  {: .lab-note .output .compact}

- {% include step_label.html %} Corrige únicamente la configuración responsable y permite que kubelet vuelva a ejecutar correctamente el static Pod afectado.

  > **Advertencia:** Si modificas `/etc/kubernetes/manifests`, no dejes copias de respaldo normales dentro de ese directorio vigilado por kubelet.
  {: .lab-note .warning .compact}

  > **Salida esperada:** El static Pod afectado vuelve a ejecutarse sin errores persistentes relacionados con la configuración incorrecta.
  {: .lab-note .output .compact}

### Tarea 6.3. Validar el resultado exacto

- {% include step_label.html %} Desde `cka-control`, espera que `scheduler-check` sea programado y alcance `Ready` después de recuperar el componente afectado.

  > **Nota:** Este Pod fue creado durante el incidente y funciona como evidencia directa de que el scheduling volvió a operar.
  {: .lab-note .info .compact}

  ```bash
  kubectl wait --for=condition=Ready pod/scheduler-check --timeout=90s
  ```

  > **Salida esperada:** `pod/scheduler-check condition met`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, confirma que el mirror Pod del scheduler vuelve a aparecer saludable dentro de `kube-system`.

  > **Importante:** No basta con que un Pod se programe; el componente del control plane debe permanecer estable después de la recuperación.
  {: .lab-note .important .compact}

  ```bash
  kubectl get pod -n kube-system -l component=kube-scheduler
  ```

  > **Salida esperada:** `kube-scheduler-cka-control` aparece `1/1` y `Running`.
  {: .lab-note .output .compact}

{% capture r6 %}{{ results[5] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r6 %}
{% include support-prompt.html task="tarea6" %}

---

## ✅ Tarea 7. Validación integral y cierre — 10 min

### Tarea 7.1. Comprobar recuperación completa

- {% include step_label.html %} Desde `cka-control`, revisa todos los nodos para confirmar que ningún incidente dejó componentes de infraestructura degradados.

  > **Nota:** La validación integral exige regresar a una condición equivalente a la línea base registrada antes de los retos.
  {: .lab-note .info .compact}

  ```bash
  kubectl get nodes
  ```

  > **Salida esperada:** Todos los nodos aparecen `Ready`, incluido `cka-worker2`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, revisa los Pods de sistema y confirma que los componentes esenciales permanecen operativos.

  > **Nota:** Presta especial atención a kube-scheduler, porque fue intervenido durante el último escenario.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pods -n kube-system
  ```

  > **Salida esperada:** Los componentes esenciales del control plane y networking aparecen `Running`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, verifica simultáneamente los workloads principales usados en los escenarios de scheduling y networking.

  > **Importante:** No realices la limpieza si alguno todavía muestra Pods `Pending`, reinicios persistentes o falta de disponibilidad.
  {: .lab-note .important .compact}

  ```bash
  kubectl get deployments -n exam-scheduling
  kubectl get deployments -n exam-network
  ```

  > **Salida esperada:** `reports` muestra `2/2` y `payments` mantiene sus dos réplicas disponibles.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, confirma por última vez que el almacenamiento recuperado mantiene el claim y el Pod en estado saludable.

  > **Nota:** Esta comprobación evita limpiar el laboratorio antes de demostrar que el volumen fue realmente recuperado.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pvc,pod -n exam-storage
  ```

  > **Salida esperada:** `app-data` aparece `Bound` y `storage-api` aparece `Running`.
  {: .lab-note .output .compact}

### Tarea 7.2. Limpiar los escenarios

- {% include step_label.html %} Desde `cka-control`, elimina los namespaces de los escenarios una vez que todos los criterios de aceptación hayan sido comprobados.

  > **Advertencia:** La limpieza elimina evidencia útil del troubleshooting; ejecútala únicamente después de completar la validación integral.
  {: .lab-note .warning .compact}

  ```bash
  kubectl delete namespace exam-scheduling exam-network exam-storage
  ```

  > **Salida esperada:** Kubernetes confirma la eliminación de los tres namespaces.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, elimina el Pod temporal utilizado para validar la recuperación del scheduler al final del último reto.

  > **Nota:** `scheduler-check` pertenece al namespace `default`, por lo que no se elimina junto con los namespaces de los escenarios.
  {: .lab-note .info .compact}

  ```bash
  kubectl delete pod scheduler-check --ignore-not-found
  ```

  > **Salida esperada:** `scheduler-check` queda eliminado o Kubernetes informa que ya no existe.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, elimina los objetos de almacenamiento de alcance de clúster creados específicamente para la Tarea 5.

  > **Importante:** Los PV y StorageClasses no pertenecen al namespace `exam-storage`, por lo que deben limpiarse explícitamente.
  {: .lab-note .important .compact}

  ```bash
  kubectl delete pv lab8-pv --ignore-not-found
  kubectl delete storageclass lab8-local --ignore-not-found
  ```

  > **Salida esperada:** `lab8-pv` y `lab8-local` dejan de existir.
  {: .lab-note .output .compact}

- {% include step_label.html %} Desde `cka-control`, ejecuta una comprobación final para confirmar que la práctica termina nuevamente con el clúster saludable.

  > **Nota:** Este criterio final debe coincidir con la línea base de la Tarea 1 y demuestra que todos los incidentes fueron recuperados.
  {: .lab-note .info .compact}

  ```bash
  kubectl get nodes
  kubectl get pods -n kube-system
  kubectl get --raw='/readyz'
  ```

  > **Salida esperada:** Todos los nodos están `Ready`, los componentes esenciales están `Running` y `/readyz` responde `ok`.
  {: .lab-note .output .compact}

{% capture r7 %}{{ results[6] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r7 %}
{% include support-prompt.html task="tarea7" %}
