---
course_id: ckapriv
lab_id: l002
tracking: true
position: 2
layout: lab
title: "Práctica 2: Mantenimiento de nodos y reprogramación de cargas"
permalink: /lab2/lab2/
images_base: /labs/lab2/img
duration: "60 minutos"
objective:
  - Aplicar operaciones administrativas de cordon, drain y uncordon sobre un nodo Kubernetes, observar la reprogramación de cargas y validar el estado operativo del clúster antes, durante y después de una ventana de mantenimiento.
prerequisites:
  - Haber completado la Práctica 1 o conocer la inspección básica de nodos, Pods y componentes del clúster.
  - Disponer del clúster CKA con cka-control y cka-worker1 en estado Ready.
  - Mantener cka-worker2 preparado pero todavía sin unir al clúster.
  - Tener acceso SSH al nodo cka-control y permisos administrativos con kubectl.
  - Contar con conectividad entre los nodos mediante la red privada 10.10.10.0/24.
introduction:
  - En esta práctica realizarás un ciclo completo de mantenimiento sobre cka-worker1. Prepararás una carga administrada capaz de reprogramarse temporalmente en el control plane, aplicarás cordon y drain, observarás el comportamiento del scheduler y de los DaemonSets, devolverás el nodo al servicio y cerrarás con un reto administrativo sin comandos prescritos.
slug: lab2
lab_number: 2
final_result: >
  Al finalizar habrás ejecutado y validado un ciclo completo de mantenimiento de cka-worker1, distinguiendo entre impedir nuevas asignaciones, evacuar cargas administradas y restaurar la capacidad de scheduling. También habrás comprobado la reprogramación de una aplicación y resuelto un escenario final con mínima guía, manteniendo cka-worker2 fuera del clúster para la práctica de kubeadm.
notes:
  - La carga de laboratorio incluye una toleration para el taint del control plane y una afinidad preferida hacia cka-worker1; esta configuración se utiliza únicamente para demostrar reprogramación con los dos nodos actualmente unidos.
  - No elimines ni unas cka-worker2 durante esta práctica. Ese nodo se reserva para la Práctica 3.
  - La práctica modifica temporalmente el estado de scheduling de cka-worker1, pero finaliza devolviendo el nodo a estado Ready y schedulable.
references:
  - text: Kubernetes - Safely Drain a Node
    url: https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/
  - text: Kubernetes - Assigning Pods to Nodes
    url: https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/
prev: /lab1/lab1/
next: /lab3/lab3/
---

---

<!-- Aquí comienzan las instrucciones paso a paso de la práctica -->

## 🔎 Tarea 1. Preparar el escenario de mantenimiento — 10 min

Validarás el estado inicial del clúster y desplegarás una aplicación administrada diseñada para preferir cka-worker1, pero capaz de ejecutarse temporalmente en el control plane durante el mantenimiento.

### Tarea 1.1. Confirmar el acceso administrativo

Verificarás que trabajas desde cka-control, que kubectl utiliza el contexto esperado y que el API Server responde antes de modificar el estado de un nodo.


{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Abre una sesión administrativa en `cka-control`, que será el punto desde el cual ejecutarás todas las operaciones de mantenimiento del clúster.

  > **Nota:** En CKA es importante identificar siempre el nodo y el contexto desde el que administras antes de modificar el estado de otros nodos.
  {: .lab-note .info .compact}

  ```bash
  ssh control@192.168.10.100
  ```

  > **Salida esperada:** Se abre una sesión remota en cka-control sin errores de conectividad.
  {: .lab-note .output .compact}

- {% include step_label.html id="s002" %} Confirma el hostname antes de continuar para evitar ejecutar operaciones administrativas desde una VM distinta.

  ```bash
  hostname
  ```

  > **Salida esperada:** El comando muestra `cka-control`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s003" %} Comprueba que `kubectl` utilizará el contexto administrativo esperado y no otro kubeconfig o contexto almacenado.

  > **Importante:** Un `cordon` o `drain` ejecutado contra el contexto equivocado puede afectar otro clúster. Esta verificación debe convertirse en un hábito operativo.
  {: .lab-note .important .compact}

  ```bash
  kubectl config current-context
  ```

  > **Salida esperada:** Se muestra `kubernetes-admin@kubernetes`.
  {: .lab-note .output .compact}

### Tarea 1.2. Revisar el estado inicial de los nodos

Comprobarás que los dos nodos actualmente unidos están disponibles y revisarás el taint del control plane que normalmente evita programar cargas de usuario sobre él.

- {% include step_label.html id="s004" %} Obtén la vista ampliada de los nodos para establecer la línea base antes del mantenimiento: estado, rol, versión e IP interna.

  > **Nota:** La comparación con esta salida te permitirá distinguir posteriormente un cambio de scheduling de una falla real del nodo.
  {: .lab-note .info .compact}

  > **Salida esperada:** `cka-control` y `cka-worker1` aparecen `Ready`; `cka-worker2` no aparece porque todavía no está unido.
  {: .lab-note .output .compact}

- {% include step_label.html id="s005" %} Verifica que `cka-worker1` inicia la práctica disponible para scheduling y sin taints que alteren el escenario.

  > **Salida esperada:** El nodo no está marcado como unschedulable y no presenta un taint administrativo que impida programar la carga del laboratorio.
  {: .lab-note .output .compact}

- {% include step_label.html id="s006" %} Identifica el taint que protege al control plane de recibir cargas de usuario de forma predeterminada.

  > **Importante:** No elimines este taint. La práctica utilizará una `toleration` específica para permitir reprogramación temporal sin alterar la configuración administrativa del nodo.
  {: .lab-note .important .compact}

  {: .lab-note .important .compact}

  > **Salida esperada:** Se observa el taint `node-role.kubernetes.io/control-plane:NoSchedule`.
  {: .lab-note .output .compact}

### Tarea 1.3. Crear la carga administrada de laboratorio

Crearás un Deployment con tres réplicas, afinidad preferida hacia cka-worker1 y toleration para que pueda reprogramarse en cka-control cuando el worker entre en mantenimiento.

- {% include step_label.html id="s007" %} Aísla todos los recursos temporales de la práctica en un namespace dedicado `lab2` para facilitar validación y limpieza.

  > **Nota:** Mantener los recursos de laboratorio en un namespace propio reduce el riesgo de confundirlos con componentes del sistema durante `drain`.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se confirma la creación del namespace `lab2`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s008" %} Construye el Deployment de prueba con tres réplicas, preferencia por `cka-worker1` y toleration para el control plane.

  > **Nota:** `preferredDuringSchedulingIgnoredDuringExecution` expresa una preferencia, no una obligación. Por eso las réplicas pueden migrar a `cka-control` cuando el worker deje de estar disponible para nuevas asignaciones. Puedes usar la imagen de ejemplo: `nginx:1.27-alpine`
  {: .lab-note .info .compact}

- {% include step_label.html id="s009" %} Aplica el manifiesto y confirma que el Deployment alcanza tres réplicas disponibles antes de iniciar el mantenimiento.

  > **Salida esperada:** El Deployment queda disponible con tres réplicas y, en condiciones normales, los Pods se programan preferentemente en `cka-worker1`.
  {: .lab-note .output .compact}

{% assign results = site.data.task-results[page.slug].results %}
{% capture r1 %}{{ results[0] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r1 %}

{% include support-prompt.html task="tarea1" %}

---

## 🚧 Tarea 2. Aplicar cordon y validar el scheduling — 10 min

Marcarás cka-worker1 como no programable sin expulsar sus Pods existentes. Después crearás una carga nueva para comprobar que cordon bloquea nuevas asignaciones, pero no afecta directamente las cargas que ya se ejecutan en el nodo.

### Tarea 2.1. Marcar cka-worker1 como unschedulable

Aplicarás cordon al worker y comprobarás la diferencia entre el estado operativo del nodo y su capacidad para recibir nuevas cargas.


{% assign tracking_task_id = "t002" %}

- {% include step_label.html id="s010" %} Marca `cka-worker1` como no programable para impedir que el scheduler coloque nuevas cargas durante la preparación del mantenimiento.

  > **Nota:** `cordon` no apaga el nodo ni expulsa Pods. Únicamente cambia `spec.unschedulable` para bloquear nuevas asignaciones.
  {: .lab-note .info .compact}

  > **Salida esperada:** kubectl confirma que `cka-worker1` fue marcado como cordoned.
  {: .lab-note .output .compact}

- {% include step_label.html id="s011" %} Comprueba cómo Kubernetes representa visualmente un nodo sano que ha sido retirado del scheduling.

  > **Importante:** `Ready,SchedulingDisabled` no significa que el nodo esté fallando; indica `Ready=True` y scheduling deshabilitado administrativamente.
  {: .lab-note .important .compact}

  > **Salida esperada:** `cka-worker1` aparece como `Ready,SchedulingDisabled`; el nodo sigue sano, pero ya no acepta nuevas asignaciones.
  {: .lab-note .output .compact}

- {% include step_label.html id="s012" %} Confirma directamente en el objeto Node que el cambio de `cordon` quedó registrado como `Unschedulable: true`.

  > **Salida esperada:** Se muestra `Unschedulable: true`.
  {: .lab-note .output .compact}

### Tarea 2.2. Comprobar dónde se programa una carga nueva

Crearás un Pod que tolera el control plane. Como cka-worker1 está cordoned, el scheduler deberá seleccionar el único nodo disponible que cumple las condiciones.

- {% include step_label.html id="s013" %} Define un Pod temporal que pueda tolerar el control plane y sirva como evidencia de que `cka-worker1` ya no acepta nuevas cargas.

  > **Nota:** Sin esta toleration el Pod podría quedar `Pending`, porque actualmente sólo `cka-control` y `cka-worker1` forman parte del clúster.
  {: .lab-note .info .compact}

- {% include step_label.html id="s014" %} Envía el Pod al API Server para que el scheduler seleccione un nodo disponible bajo las condiciones actuales.

  > **Salida esperada:** Se crea el Pod `cordon-test`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s015" %} Espera a que el Pod esté operativo y comprueba el nodo elegido por el scheduler después de aplicar `cordon`.

  > **Nota:** La columna `NODE` es la evidencia que relaciona el estado `SchedulingDisabled` con la decisión del scheduler.
  {: .lab-note .info .compact}

  > **Salida esperada:** El Pod queda `Running` en `cka-control`, porque `cka-worker1` no acepta nuevas cargas mientras permanece cordoned.
  {: .lab-note .output .compact}

### Tarea 2.3. Confirmar que cordon no evacúa Pods existentes

Revisarás la aplicación previa para comprobar que cordon cambia el scheduling futuro, pero no elimina ni migra automáticamente los Pods que ya estaban en el worker.

- {% include step_label.html id="s016" %} Comprueba que las réplicas que ya estaban ejecutándose en `cka-worker1` continúan allí después de `cordon`.

  > **Nota:** Este paso demuestra la diferencia operacional clave: `cordon` evita nuevas asignaciones, mientras que `drain` intenta evacuar cargas existentes.
  {: .lab-note .info .compact}

  > **Salida esperada:** Los Pods existentes continúan ejecutándose; los que estaban en `cka-worker1` no fueron expulsados por `cordon`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s017" %} Inspecciona los eventos para observar la decisión de scheduling y relacionarla con el estado administrativo del worker.

  > **Salida esperada:** Los eventos muestran la creación y asignación del Pod temporal y de los Pods de la aplicación sin fallas persistentes.
  {: .lab-note .output .compact}

- {% include step_label.html id="s018" %} Elimina únicamente el Pod de comprobación para dejar activa sólo la carga que será utilizada durante el `drain`.

  > **Salida esperada:** El Pod `cordon-test` se elimina y el Deployment `maintenance-app` permanece activo.
  {: .lab-note .output .compact}

{% capture r2 %}{{ results[1] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r2 %}

{% include support-prompt.html task="tarea2" %}

---

## 🔄 Tarea 3. Drenar el nodo y observar la reprogramación — 17 min

Ejecutarás drain sobre cka-worker1 para evacuar cargas administradas. Observarás cómo los Pods del Deployment son recreados en otro nodo y distinguirás las cargas administradas por controladores de los Pods pertenecientes a DaemonSets.

### Tarea 3.1. Preparar y ejecutar el drain

Confirmarás qué cargas existen en el worker, ejecutarás el drenado con la opción adecuada para DaemonSets y comprobarás que el nodo permanece fuera del scheduling.


{% assign tracking_task_id = "t003" %}

- {% include step_label.html id="s019" %} Inventaría las cargas que existen en `cka-worker1` antes de drenarlo y distingue aplicaciones de componentes de infraestructura.

  > **Importante:** Antes de ejecutar `drain`, revisa qué Pods existen en el nodo. Esto permite anticipar objetos que podrían bloquear la evacuación.
  {: .lab-note .important .compact}

  > **Salida esperada:** Se observan Pods del Deployment de laboratorio y Pods de infraestructura como `calico-node` y `kube-proxy`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s020" %} Identifica los DaemonSets del clúster para entender qué Pods deben permanecer en el nodo durante el drenado.

  > **Nota:** `drain` no elimina Pods de DaemonSets porque éstos representan normalmente agentes por nodo, como CNI o `kube-proxy`; por ello utilizarás `--ignore-daemonsets`.
  {: .lab-note .info .compact}

- {% include step_label.html id="s021" %} Drena `cka-worker1` para evacuar las cargas administradas y preparar el nodo para una intervención.

  > **Importante:** Usa únicamente `--ignore-daemonsets`. No agregues `--force` ni `--delete-emptydir-data` si el comando no los solicita; en un escenario CKA debes interpretar primero la causa de cualquier bloqueo.
  {: .lab-note .important .compact}

  > **Salida esperada:** Los Pods administrados que pueden ser desalojados son evicted y el comando finaliza indicando que el nodo fue drained.
  {: .lab-note .output .compact}

- {% include step_label.html id="s022" %} Confirma que el nodo quedó drenado y sigue protegido contra nuevas asignaciones.

  > **Nota:** `drain` aplica el equivalente de un `cordon` como parte del proceso; el nodo debe permanecer `SchedulingDisabled` hasta ejecutar `uncordon`.
  {: .lab-note .info .compact}

  > **Salida esperada:** `cka-worker1` permanece `Ready,SchedulingDisabled`.
  {: .lab-note .output .compact}

### Tarea 3.2. Observar la reprogramación de la aplicación

Revisarás los Pods recreados por el Deployment y verificarás que el scheduler utiliza temporalmente cka-control gracias a la toleration incluida en la carga.

- {% include step_label.html id="s023" %} Observa en tiempo real cómo desaparecen las réplicas desalojadas y aparecen los reemplazos creados por el Deployment.

  > **Nota:** Kubernetes no “mueve” un Pod existente; el controlador crea Pods nuevos para recuperar el estado deseado después de la eviction.
  {: .lab-note .info .compact}

  > **Nota:** Presiona `Ctrl+C` cuando las tres réplicas aparezcan `Running`.
  {: .lab-note .info .compact}

- {% include step_label.html id="s024" %} Verifica que las nuevas réplicas fueron programadas en `cka-control`, el único nodo schedulable que tolera la carga.

  > **Salida esperada:** Las tres réplicas están `Running` y se encuentran en `cka-control` mientras el worker está drenado.
  {: .lab-note .output .compact}

- {% include step_label.html id="s025" %} Confirma que el controlador del Deployment recuperó el estado deseado de tres réplicas tras la evacuación.

  > **Nota:** Esta validación diferencia la continuidad declarativa de un Deployment del ciclo de vida individual de sus Pods.
  {: .lab-note .info .compact}

  > **Salida esperada:** `READY`, `UP-TO-DATE` y `AVAILABLE` convergen en `3`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s026" %} Revisa los eventos para reconstruir cronológicamente la eviction y posterior programación de los reemplazos.

  > **Salida esperada:** Los eventos permiten relacionar la eliminación de Pods anteriores con la creación y programación de sus reemplazos.
  {: .lab-note .output .compact}

### Tarea 3.3. Distinguir Pods administrados por DaemonSets

Comprobarás que las cargas de infraestructura administradas por DaemonSets permanecen en el nodo aunque las cargas ordinarias hayan sido evacuadas.

- {% include step_label.html id="s027" %} Comprueba qué cargas permanecen físicamente en `cka-worker1` después del drain.

  > **Nota:** Los Pods de DaemonSets permanecen porque su presencia está ligada al nodo y fueron excluidos explícitamente del drain.
  {: .lab-note .info .compact}

  > **Salida esperada:** Los Pods del Deployment ya no están en el worker, pero continúan Pods de DaemonSets como `calico-node` y `kube-proxy`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s028" %} Comprueba el `ownerReference` de `kube-proxy` para demostrar que Kubernetes lo administra mediante un DaemonSet.

  > **Salida esperada:** El owner se identifica como `DaemonSet`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s029" %} Relaciona el Pod observado con el estado deseado del DaemonSet `kube-proxy`.

  > **Salida esperada:** El DaemonSet mantiene una instancia por cada nodo unido que corresponde a su selector.
  {: .lab-note .output .compact}

### Tarea 3.4. Validar la salud del clúster durante el mantenimiento

Confirmarás que el control plane y la aplicación siguen operativos mientras cka-worker1 permanece drenado y sin aceptar nuevas cargas.

- {% include step_label.html id="s030" %} Verifica que el mantenimiento del worker no afecta la disponibilidad del API Server del control plane.

  > **Salida esperada:** El API Server responde `ok`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s031" %} Confirma que la aplicación mantiene todas sus réplicas disponibles mientras el worker permanece drenado.

  > **Salida esperada:** Las tres réplicas de `maintenance-app` permanecen `Running` sin Pods `Pending`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s032" %} Consulta directamente la condición `Ready` para separar salud del nodo de capacidad de scheduling.

  > **Importante:** Un nodo drenado puede seguir completamente sano. `Ready=True` y `SchedulingDisabled` describen dos dimensiones distintas del estado.
  {: .lab-note .important .compact}

  > **Salida esperada:** Se muestra `True`; drain afecta la colocación de cargas, no convierte por sí mismo al nodo en NotReady.
  {: .lab-note .output .compact}

{% capture r3 %}{{ results[2] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r3 %}

{% include support-prompt.html task="tarea3" %}

---

## ✅ Tarea 4. Devolver el nodo al servicio — 11 min

Restaurarás la capacidad de scheduling de cka-worker1 y provocarás una nueva creación controlada de Pods para comprobar que la afinidad preferida vuelve a favorecer al worker cuando está disponible.

### Tarea 4.1. Aplicar uncordon

Harás que el worker vuelva a aceptar nuevas cargas y comprobarás que el nodo continúa sano después de la ventana de mantenimiento.


{% assign tracking_task_id = "t004" %}

- {% include step_label.html id="s033" %} Ejecuta `uncordon` para permitir nuevamente que el scheduler considere `cka-worker1` para cargas nuevas.

  > **Nota:** `uncordon` no obliga a que los Pods existentes regresen al worker; sólo vuelve a habilitarlo como candidato para nuevas asignaciones.
  {: .lab-note .info .compact}

  > **Salida esperada:** kubectl informa que `cka-worker1` fue uncordoned.
  {: .lab-note .output .compact}

- {% include step_label.html id="s034" %} Verifica que `SchedulingDisabled` desapareció y que ambos nodos continúan `Ready`.

  > **Salida esperada:** `cka-control` y `cka-worker1` aparecen `Ready` y ya no se muestra `SchedulingDisabled`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s035" %} Confirma en el objeto Node que `spec.unschedulable` volvió a su estado normal.

  > **Salida esperada:** Se muestra `Unschedulable: false`.
  {: .lab-note .output .compact}

### Tarea 4.2. Comprobar la programación después del mantenimiento

Recrearás las réplicas del Deployment para observar que el scheduler vuelve a preferir cka-worker1 una vez que el nodo está disponible.

- {% include step_label.html id="s036" %} Inicia un nuevo rollout para generar Pods nuevos y comprobar si el scheduler vuelve a preferir `cka-worker1`.

  > **Nota:** No estás “moviendo” los Pods del control plane. El reinicio genera un nuevo ReplicaSet y nuevas decisiones de scheduling.
  {: .lab-note .info .compact}

  > **Salida esperada:** Kubernetes confirma el reinicio del Deployment.
  {: .lab-note .output .compact}

- {% include step_label.html id="s037" %} Espera a que la sustitución controlada de réplicas termine antes de evaluar su ubicación.

  > **Salida esperada:** El rollout termina correctamente sin réplicas no disponibles.
  {: .lab-note .output .compact}

- {% include step_label.html id="s038" %} Comprueba la columna `NODE` y valida el efecto de la afinidad preferida una vez restaurado el worker.

  > **Salida esperada:** El scheduler vuelve a preferir `cka-worker1` para las réplicas nuevas, de acuerdo con la afinidad definida.
  {: .lab-note .output .compact}

### Tarea 4.3. Validar el estado previo al reto

Confirmarás que el clúster y la aplicación se encuentran estables antes de resolver el escenario final con mínima guía.

- {% include step_label.html id="s039" %} Establece una nueva línea base antes del reto: ambos nodos deben estar sanos y aceptar scheduling.

  > **Salida esperada:** Ambos nodos unidos están `Ready` y schedulable.
  {: .lab-note .output .compact}

- {% include step_label.html id="s040" %} Verifica que el Deployment haya convergido y que no queden réplicas indisponibles antes del escenario sin guía.

  > **Salida esperada:** Las tres réplicas están disponibles.
  {: .lab-note .output .compact}

- {% include step_label.html id="s041" %} Descarta problemas de scheduling pendientes antes de iniciar el reto administrativo.

  > **Salida esperada:** No se muestran Pods pendientes.
  {: .lab-note .output .compact}

{% capture r4 %}{{ results[3] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r4 %}

{% include support-prompt.html task="tarea4" %}

---

## 🧩 Tarea 5. Reto de mantenimiento administrativo — 12 min

Resolverás un segundo ciclo de mantenimiento sin comandos prescritos. Utiliza únicamente las técnicas practicadas para proteger el scheduling, evacuar la aplicación, validar la continuidad y devolver cka-worker1 al servicio.

### Tarea 5.1. Ejecutar una ventana de mantenimiento sin guía de comandos

Debes preparar cka-worker1 para una intervención administrativa, retirar las cargas administradas y demostrar que la aplicación continúa disponible en el clúster.


{% assign tracking_task_id = "t005" %}

- {% include step_label.html id="s042" %} Determina por tu cuenta si `cka-worker1` inicia el reto sano y habilitado para recibir nuevas cargas.

  > **Nota:** En esta sección ya no se proporcionan comandos. Selecciona las consultas administrativas adecuadas a partir de lo practicado.
  {: .lab-note .info .compact}

  > **Criterio del reto:** Conserva evidencia de que el nodo está `Ready` y no está marcado como `SchedulingDisabled`.
  {: .lab-note .important .compact}

- {% include step_label.html id="s043" %} Coloca `cka-worker1` en un estado seguro de pre-mantenimiento donde continúe operativo pero no reciba nuevas asignaciones.

  > **Criterio del reto:** El nodo debe seguir sano, pero quedar marcado como no programable.
  {: .lab-note .important .compact}

- {% include step_label.html id="s044" %} Evacúa del worker las cargas administradas que sí deben abandonar el nodo, preservando correctamente los Pods de DaemonSets.

  > **Criterio del reto:** No utilices opciones destructivas que no sean necesarias para este escenario.
  {: .lab-note .warning .compact}

- {% include step_label.html id="s045" %} Demuestra con evidencia del clúster que el Deployment recuperó sus tres réplicas después de la evacuación.

  > **Salida esperada:** La aplicación mantiene tres réplicas disponibles y ninguna réplica administrada permanece en cka-worker1.
  {: .lab-note .output .compact}

### Tarea 5.2. Restaurar el servicio y cerrar la práctica

Devolverás el worker al scheduling, validarás la salud final del clúster y eliminarás exclusivamente los recursos creados por esta práctica.

- {% include step_label.html id="s046" %} Finaliza la ventana de mantenimiento devolviendo `cka-worker1` al conjunto de nodos candidatos para scheduling.

  > **Criterio del reto:** El nodo debe terminar `Ready` y sin `SchedulingDisabled`.
  {: .lab-note .important .compact}

- {% include step_label.html id="s047" %} Genera nuevas réplicas mediante una operación sobre el Deployment y comprueba que `cka-worker1` vuelve a participar en el scheduling.

  > **Criterio del reto:** Utiliza una operación sobre el Deployment, no elimines Pods individuales uno por uno.
  {: .lab-note .important .compact}

- {% include step_label.html id="s048" %} Realiza una validación integral del estado final: nodos, disponibilidad de la aplicación y salud del API Server.

  > **Salida esperada:** Ambos nodos unidos están `Ready`, la aplicación está disponible y el API Server responde correctamente.
  {: .lab-note .output .compact}

- {% include step_label.html id="s049" %} Limpia exclusivamente los recursos temporales del laboratorio y conserva intacta la infraestructura base del clúster.

  > **Importante:** Antes de limpiar, confirma que `cka-worker1` ya está `Ready` y schedulable. No finalices la práctica dejando el nodo cordoned.
  {: .lab-note .important .compact}

  > **Advertencia:** Elimina solamente los recursos de esta práctica. No modifiques `kube-system`, Calico, CoreDNS, kube-proxy ni cka-worker2.
  {: .lab-note .warning .compact}

  > **Salida esperada:** El namespace `lab2` deja de existir, cka-worker1 permanece `Ready` y cka-worker2 continúa sin unir al clúster.
  {: .lab-note .output .compact}

{% capture r5 %}{{ results[4] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r5 %}

{% include support-prompt.html task="tarea5" %}
