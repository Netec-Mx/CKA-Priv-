---
course_id: ckapriv
lab_id: l006
tracking: true
position: 6
layout: lab
title: "Práctica 6: Diagnóstico de CNI, kube-proxy y CoreDNS"
permalink: /lab6/lab6/
images_base: /labs/lab6/img
duration: "55 minutos"
objective:
  - Diagnosticar problemas de conectividad Pod-to-Pod, acceso a Services y resolución DNS en Kubernetes, relacionando CNI, kube-proxy, EndpointSlices y CoreDNS mediante escenarios guiados y fallas controladas.
prerequisites:
  - Haber completado la Práctica 5 y disponer del clúster CKA operativo.
  - Tener kubectl configurado con acceso administrativo al clúster.
  - Contar con al menos dos nodos disponibles para ejecutar workloads.
  - Tener un plugin CNI funcional instalado en el clúster.
  - Tener kube-proxy y CoreDNS desplegados en kube-system.
  - Trabajar desde Visual Studio Code utilizando Git Bash como terminal principal.
introduction:
  - En esta práctica construirás primero una línea base de red y DNS para reconocer cómo se comporta un clúster sano. Validarás comunicación entre Pods, acceso mediante Services, EndpointSlices y resolución de nombres con CoreDNS. Después trabajarás con tres escenarios de troubleshooting en los que observarás síntomas, localizarás el componente responsable y recuperarás el servicio sin recibir directamente la solución en los primeros pasos de diagnóstico.
slug: lab6
lab_number: 6
final_result: >
  Al finalizar habrás validado el funcionamiento del CNI, kube-proxy, Services, EndpointSlices y CoreDNS; diagnosticado una falla de resolución DNS, un Service sin backends y una restricción de conectividad aplicada por el CNI; y recuperado la comunicación completa del entorno utilizando evidencias obtenidas con kubectl.
notes:
  - La práctica utiliza fallas controladas y reversibles. No detendrás kubelet, containerd ni componentes del control plane.
  - El Service de DNS se llama kube-dns incluso cuando la implementación utilizada es CoreDNS.
  - kube-proxy puede utilizar diferentes modos según la versión y configuración del clúster. La práctica no presupone iptables, IPVS o nftables; primero identificarás el modo utilizado.
  - Los escenarios de troubleshooting deben resolverse a partir de síntomas y evidencias. Evita realizar cambios antes de identificar la causa.
  - Conserva los manifiestos creados en workspace/lab6 hasta finalizar la práctica.
references:
  - text: Debugging DNS Resolution
    url: https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/
  - text: Service
    url: https://kubernetes.io/docs/concepts/services-networking/service/
  - text: Network Policies
    url: https://kubernetes.io/docs/concepts/services-networking/network-policies/
  - text: kube-proxy
    url: https://kubernetes.io/docs/reference/command-line-tools-reference/kube-proxy/
prev: /lab5/lab5/
next: /lab7/lab7/
---

---

<!-- Aquí comienzan las instrucciones paso a paso de la práctica -->

## 🔎 Tarea 1. Establecer la línea base de red del clúster — 5 min

Antes de diagnosticar una falla necesitas conocer el estado normal del entorno. Revisarás los componentes que participan en la conectividad y la resolución DNS.

### Tarea 1.1. Confirmar el estado de los nodos


{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Consulta los nodos y confirma que el clúster está estable antes de modificar recursos de red.

  > **Nota:** Una condición `NotReady` puede producir síntomas de red que no están relacionados directamente con CNI, kube-proxy o CoreDNS. Por eso primero se valida la salud general.
  {: .lab-note .info .compact}

  > **Salida esperada:** Los nodos utilizados en la práctica aparecen en estado `Ready`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s002" %} Consulta las condiciones principales de los nodos.

  > **Nota:** `NetworkUnavailable` ayuda a detectar si Kubernetes considera que existe un problema con la red del nodo.
  {: .lab-note .info .compact}

  > **Salida esperada:** `READY` aparece como `True`; `NETWORK_UNAVAILABLE` normalmente aparece `False` o vacío según el CNI.
  {: .lab-note .output .compact}

- {% include step_label.html id="s003" %} Comprueba que los nodos tienen asignadas direcciones internas.

  > **Nota:** Las direcciones de nodo forman parte del camino utilizado para comunicación entre hosts y pueden ayudar a diferenciar problemas de red física de problemas dentro del clúster.
  {: .lab-note .info .compact}

  > **Salida esperada:** Cada nodo muestra una `InternalIP`.
  {: .lab-note .output .compact}

### Tarea 1.2. Revisar CNI, kube-proxy y CoreDNS

- {% include step_label.html id="s004" %} Lista los Pods de `kube-system` y localiza los componentes relacionados con red y DNS.

  > **Importante:** No asumas que todos los CNIs utilizan los mismos nombres de Pods. Identifica el plugin realmente desplegado en tu clúster.
  {: .lab-note .important .compact}

  > **Salida esperada:** CoreDNS y kube-proxy aparecen operativos, junto con los Pods correspondientes al CNI instalado.
  {: .lab-note .output .compact}

- {% include step_label.html id="s005" %} Comprueba específicamente los Pods de kube-proxy.

  > **Nota:** kube-proxy suele ejecutarse como DaemonSet para mantener la programación de tráfico de Services en cada nodo.
  {: .lab-note .info .compact}

  > **Salida esperada:** Existe un Pod de kube-proxy por cada nodo donde deba ejecutarse.
  {: .lab-note .output .compact}

- {% include step_label.html id="s006" %} Comprueba los Pods de CoreDNS.

  > **Nota:** Kubernetes conserva la etiqueta `k8s-app=kube-dns` por compatibilidad, aunque la implementación sea CoreDNS.
  {: .lab-note .info .compact}

  > **Salida esperada:** Los Pods de CoreDNS aparecen en estado `Running`.
  {: .lab-note .output .compact}

### Tarea 1.3. Identificar el modo de kube-proxy y el Service DNS

- {% include step_label.html id="s007" %} Consulta el ConfigMap de kube-proxy para identificar el modo configurado.

  > **Nota:** En Kubernetes actuales kube-proxy puede trabajar con implementaciones distintas. La forma correcta de diagnosticarlo es consultar su configuración en lugar de asumir el modo.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se muestra el valor de `mode`; si aparece vacío, kube-proxy utilizará el comportamiento determinado por su configuración y versión.
  {: .lab-note .output .compact}

- {% include step_label.html id="s008" %} Consulta el Service que expone CoreDNS.

  > **Nota:** Los Pods no consultan directamente una IP de CoreDNS elegida manualmente. Normalmente utilizan la `ClusterIP` del Service `kube-dns`.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se muestra un Service `ClusterIP` con los puertos DNS 53/UDP y 53/TCP.
  {: .lab-note .output .compact}

- {% include step_label.html id="s009" %} Consulta los EndpointSlices asociados al Service DNS.

  > **Nota:** Un Service necesita backends disponibles. EndpointSlice relaciona el Service con las direcciones de los Pods que pueden recibir tráfico.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se muestran una o más direcciones correspondientes a CoreDNS.
  {: .lab-note .output .compact}

{% assign results = site.data.task-results[page.slug].results %}
{% capture r1 %}{{ results[0] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r1 %}

{% include support-prompt.html task="tarea1" %}

---

## 🌐 Tarea 2. Validar conectividad Pod-to-Pod y Pod-to-Service — 6 min

Crearás una aplicación de prueba con dos réplicas y un cliente. Así podrás comparar tráfico directo hacia Pods con tráfico dirigido a través de un Service.

### Tarea 2.1. Crear el escenario de red


{% assign tracking_task_id = "t002" %}

- {% include step_label.html id="s010" %} Crea el namespace `net-lab`.

  > **Nota:** Mantener los recursos de diagnóstico en un namespace separado facilita la limpieza y evita mezclar políticas con otras aplicaciones.
  {: .lab-note .info .compact}

  > **Salida esperada:** `namespace/net-lab created`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s011" %} Crea un Deployment de NGINX con dos réplicas.

  > **Nota:** Las dos réplicas permiten observar varios backends detrás del mismo Service y comprobar la relación entre Pods y EndpointSlices.
  {: .lab-note .info .compact}

  > **Salida esperada:** `deployment.apps/web created`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s012" %} Espera a que las dos réplicas estén disponibles.

  > **Importante:** No continúes con pruebas de conectividad mientras los backends aún están iniciando, porque podrías interpretar un problema de readiness como una falla de red.
  {: .lab-note .important .compact}

  > **Salida esperada:** El Deployment completa correctamente su rollout.
  {: .lab-note .output .compact}

### Tarea 2.2. Exponer y revisar el Service

- {% include step_label.html id="s013" %} Expón el Deployment mediante un Service `ClusterIP`.

  > **Nota:** Un Service proporciona una dirección virtual estable aunque las IP de los Pods cambien.
  {: .lab-note .info .compact}

  > **Salida esperada:** `service/web-svc exposed`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s014" %} Consulta la `ClusterIP` asignada.

  > **Nota:** Esta IP pertenece al espacio virtual de Services; no corresponde a una interfaz de red dentro de un Pod.
  {: .lab-note .info .compact}

  > **Salida esperada:** `web-svc` muestra una `CLUSTER-IP` y el puerto `80/TCP`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s015" %} Consulta los EndpointSlices del Service.

  > **Nota:** Las direcciones mostradas deben corresponder a Pods seleccionados por `web-svc`. Si no existen endpoints, kube-proxy no tiene backends válidos a los cuales dirigir tráfico.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se observan dos endpoints asociados a las dos réplicas de NGINX.
  {: .lab-note .output .compact}

### Tarea 2.3. Comparar tráfico directo y tráfico por Service

- {% include step_label.html id="s016" %} Crea un Pod cliente que permanecerá disponible para las pruebas. Puedes usar la imagen **curl:8.16.0**

  > **Nota:** El cliente proporciona un punto de observación dentro de la red del clúster, que es donde deben probarse las IP de Pods y las ClusterIP.
  {: .lab-note .info .compact}

  > **Salida esperada:** `pod/net-client created`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s017" %} Espera a que el cliente esté listo.

  > **Nota:** `kubectl wait` evita lanzar las pruebas antes de que el contenedor pueda ejecutar comandos.
  {: .lab-note .info .compact}

  > **Salida esperada:** `pod/net-client condition met`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s018" %} Obtén una IP de Pod backend y realiza una solicitud directa. Puedes guardarla en la variable **POD_IP**

  > **Nota:** Esta prueba evita el Service y verifica principalmente la ruta Pod-to-Pod proporcionada por el CNI.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se recibe contenido HTML de NGINX.
  {: .lab-note .output .compact}

- {% include step_label.html id="s019" %} Realiza ahora la misma solicitud utilizando la IP virtual del Service.

  > **Nota:** Si la IP directa funciona pero la ClusterIP falla, el diagnóstico debe enfocarse en Service, EndpointSlices o el mecanismo de proxy de Services.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se recibe nuevamente contenido HTML de NGINX.
  {: .lab-note .output .compact}

{% capture r2 %}{{ results[1] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r2 %}

{% include support-prompt.html task="tarea2" %}

---

## 🧭 Tarea 3. Validar resolución DNS desde un Pod — 6 min

Comprobarás cómo un Pod recibe la dirección del DNS del clúster y cómo CoreDNS resuelve nombres de Services.

### Tarea 3.1. Crear un Pod de diagnóstico DNS


{% assign tracking_task_id = "t003" %}

- {% include step_label.html id="s020" %} Crea un Pod con herramientas de resolución DNS. Puedes usar el nombre **dns-client.yaml** y la imagen **agnhost:2.39**

  > **Salida esperada:** `pod/dns-client created`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s021" %} Espera a que el Pod DNS esté listo.

  > **Nota:** Las pruebas de resolución deben realizarse únicamente después de que el contenedor esté en ejecución.
  {: .lab-note .info .compact}

  > **Salida esperada:** `pod/dns-client condition met`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s022" %} Revisa el archivo `/etc/resolv.conf` del Pod.

  > **Importante:** El `nameserver` debe apuntar normalmente a la ClusterIP del Service `kube-dns`, no a la dirección DNS configurada directamente en el nodo.
  {: .lab-note .important .compact}

  > **Salida esperada:** Se observa un `nameserver` del clúster y dominios de búsqueda como `net-lab.svc.cluster.local`.
  {: .lab-note .output .compact}

### Tarea 3.2. Resolver nombres de Kubernetes

- {% include step_label.html id="s023" %} Resuelve el Service interno `kubernetes.default`.

  > **Nota:** Este nombre es una prueba estándar porque el Service `kubernetes` existe normalmente en el namespace `default`.
  {: .lab-note .info .compact}

  > **Salida esperada:** La consulta devuelve una dirección IP sin errores de resolución.
  {: .lab-note .output .compact}

- {% include step_label.html id="s024" %} Resuelve el nombre corto `web-svc`.

  > **Nota:** Como el cliente se encuentra en `net-lab`, el search domain permite resolver el Service del mismo namespace utilizando únicamente su nombre corto.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se devuelve la ClusterIP de `web-svc`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s025" %} Resuelve el FQDN completo del Service.

  > **Nota:** El nombre completo evita depender de los search domains y resulta útil al diagnosticar resolución entre namespaces.
  {: .lab-note .info .compact}

  > **Salida esperada:** El FQDN resuelve a la misma ClusterIP de `web-svc`.
  {: .lab-note .output .compact}

### Tarea 3.3. Relacionar CoreDNS con sus endpoints

- {% include step_label.html id="s026" %} Obtén la ClusterIP del Service DNS. Pueds usar la variable **DNS_IP**

  > **Nota:** Guardar esta IP permite compararla con el `nameserver` observado dentro del Pod.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se muestra la dirección IP del DNS del clúster.
  {: .lab-note .output .compact}

- {% include step_label.html id="s027" %} Consulta nuevamente los EndpointSlices de `kube-dns`.

  > **Nota:** Una ClusterIP puede existir aunque no haya backends. Por eso la revisión de EndpointSlices es parte esencial del troubleshooting de Services.
  {: .lab-note .info .compact}

  > **Salida esperada:** Existen endpoints listos para recibir consultas DNS.
  {: .lab-note .output .compact}

- {% include step_label.html id="s028" %} Revisa los logs recientes de CoreDNS.

  > **Nota:** Los logs permiten identificar errores de configuración, problemas de forwarding y fallos de comunicación con resolvers upstream. Un timeout hacia un DNS externo no implica necesariamente que la resolución interna de Kubernetes esté fallando.
  {: .lab-note .info .compact}

  > **Salida esperada:** CoreDNS se encuentra iniciado y procesando consultas.Pueden aparecer advertencias o timeouts hacia resolvers upstream externos; estos mensajes deben analizarse junto con las pruebas de resolución interna.
  {: .lab-note .output .compact}

{% capture r3 %}{{ results[2] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r3 %}

{% include support-prompt.html task="tarea3" %}

---

## 🧠 Tarea 4. Construir un flujo de diagnóstico de red — 6 min

Antes de recibir fallas identificarás qué evidencias permiten separar problemas de CNI, Service proxy y DNS.

### Tarea 4.1. Relacionar Pods, Services y EndpointSlices


{% assign tracking_task_id = "t004" %}

- {% include step_label.html id="s029" %} Consulta las etiquetas utilizadas por los Pods `web`.

  > **Nota:** Los Services seleccionan Pods mediante labels. Una diferencia mínima entre selector y label puede dejar un Service sin endpoints.
  {: .lab-note .info .compact}

  > **Salida esperada:** Los Pods muestran la etiqueta `app=web`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s030" %} Consulta el selector configurado en `web-svc`.

  > **Nota:** Comparar selector y labels es uno de los primeros pasos cuando una ClusterIP existe pero no entrega tráfico.
  {: .lab-note .info .compact}

  > **Salida esperada:** El selector contiene `app:web`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s031" %} Describe el Service y revisa el campo de endpoints.

  > **Nota:** `kubectl describe service` reúne puertos, selector y backends en una sola vista útil para diagnóstico.
  {: .lab-note .info .compact}

  > **Salida esperada:** El Service muestra endpoints asociados al puerto 80.
  {: .lab-note .output .compact}

### Tarea 4.2. Revisar el estado de kube-proxy

- {% include step_label.html id="s032" %} Consulta el DaemonSet de kube-proxy.

  > **Nota:** El número `READY` debería corresponder con los nodos donde kube-proxy debe estar ejecutándose.
  {: .lab-note .info .compact}

  > **Salida esperada:** `DESIRED`, `CURRENT`, `READY` y `AVAILABLE` muestran valores consistentes.
  {: .lab-note .output .compact}

- {% include step_label.html id="s033" %} Revisa logs recientes de kube-proxy.

  > **Nota:** Los logs pueden revelar errores al sincronizar reglas, problemas con el kernel o el modo de proxy utilizado.
  {: .lab-note .info .compact}

  > **Salida esperada:** No aparecen errores persistentes de sincronización.
  {: .lab-note .output .compact}

- {% include step_label.html id="s034" %} Verifica nuevamente que la ClusterIP de `web-svc` responde desde el cliente.

  > **Nota:** Esta comprobación completa la línea base antes de introducir fallas controladas.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se recibe contenido HTML.
  {: .lab-note .output .compact}

### Tarea 4.3. Establecer el orden de diagnóstico

- {% include step_label.html id="s035" %} Comprueba conectividad directa hacia la IP de un Pod.

  > **Importante:** Si falla la comunicación Pod-to-Pod por IP, investiga primero el CNI o una política de red antes de culpar al DNS.
  {: .lab-note .important .compact}

  > **Salida esperada:** La IP directa responde.
  {: .lab-note .output .compact}

- {% include step_label.html id="s036" %} Comprueba conectividad por nombre de Service.

  > **Nota:** Si la IP directa funciona pero el nombre no, separa la prueba en dos: resolución DNS y conectividad hacia la ClusterIP.
  {: .lab-note .info .compact}

  > **Salida esperada:** El Service responde.
  {: .lab-note .output .compact}

- {% include step_label.html id="s037" %} Comprueba únicamente la resolución DNS del Service.

  > **Nota:** Esta prueba no necesita abrir la aplicación; sirve para aislar la capa DNS del resto de la comunicación.
  {: .lab-note .info .compact}

  > **Salida esperada:** El nombre resuelve correctamente.
  {: .lab-note .output .compact}

{% capture r4 %}{{ results[3] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r4 %}

{% include support-prompt.html task="tarea4" %}

---

## 🧩 Tarea 5. Troubleshooting: falla de resolución DNS — 7 min

En este escenario el Service DNS seguirá existiendo y los Pods de CoreDNS continuarán ejecutándose, pero las consultas dejarán de alcanzar los backends correctos.

### Tarea 5.1. Introducir y observar la falla

> **Advertencia:** El siguiente cambio afecta temporalmente la resolución DNS de los Pods del clúster. No cierres la terminal y no realices cambios adicionales en `kube-dns` hasta completar este escenario.
{: .lab-note .warning .compact}


{% assign tracking_task_id = "t005" %}

- {% include step_label.html id="s038" %} Guarda el Service funcional antes de modificarlo. Puedes usar este nombre para guardarlo **kube-dns-service.before.yaml**

  > **Nota:** Antes de modificar un recurso crítico debes conservar evidencia de su configuración funcional.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se crea `kube-dns-service.before.yaml`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s039" %} Cambia temporalmente el selector de `kube-dns` por un valor que no coincide con CoreDNS.

  > **Importante:** El objetivo es provocar un Service sin backends sin detener los Pods de CoreDNS. Esto permite separar claramente la existencia del componente de su exposición mediante Service.
  {: .lab-note .important .compact}

  > **Salida esperada:** Kubernetes informa que el Service fue actualizado.
  {: .lab-note .output .compact}

- {% include step_label.html id="s040" %} Intenta resolver `kubernetes.default` desde `dns-client`.

  > **Nota:** En este punto debes centrarte primero en el síntoma: el Pod conserva su configuración DNS, pero el Service DNS ya no tiene backends correctos.
  {: .lab-note .info .compact}

  > **Salida esperada:** La consulta falla o expira.
  {: .lab-note .output .compact}

### Tarea 5.2. Diagnosticar sin corregir todavía

- {% include step_label.html id="s041" %} Comprueba que los Pods de CoreDNS siguen `Running`.

  > **Nota:** Si CoreDNS está ejecutándose pero DNS falla, debes continuar hacia Service y EndpointSlices en lugar de reiniciar inmediatamente los Pods.
  {: .lab-note .info .compact}

  > **Salida esperada:** Los Pods de CoreDNS permanecen `Running`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s042" %} Examina el Service `kube-dns` y determina qué cambió respecto a la línea base.

  > **Importante:** No corrijas todavía el recurso. Identifica primero el selector configurado y compáralo con las labels de CoreDNS.
  {: .lab-note .important .compact}

  > **Salida esperada:** El selector muestra `k8s-app=dns-broken` y no aparecen backends válidos.
  {: .lab-note .output .compact}

- {% include step_label.html id="s043" %} Revisa los EndpointSlices asociados con `kube-dns`.

  > **Nota:** La ausencia de endpoints confirma que el fallo se encuentra entre el Service y sus backends, no en el proceso CoreDNS.
  {: .lab-note .info .compact}

  > **Salida esperada:** No se muestran direcciones de CoreDNS como endpoints disponibles.
  {: .lab-note .output .compact}

### Tarea 5.3. Recuperar DNS y validar

- {% include step_label.html id="s044" %} Compara las labels de CoreDNS con el selector actual del Service e identifica el valor que debe recuperarse.

  > **Nota:** El objetivo del troubleshooting es justificar la corrección a partir de la evidencia, no recordar de memoria el selector.
  {: .lab-note .info .compact}

  > **Salida esperada:** Los Pods muestran la label `k8s-app=kube-dns`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s045" %} Restaura el selector correcto del Service.

  > **Importante:** La corrección modifica únicamente la causa identificada; no reinicies CoreDNS ni kube-proxy si no existe evidencia que lo requiera.
  {: .lab-note .important .compact}

  > **Salida esperada:** Kubernetes confirma la actualización del Service.
  {: .lab-note .output .compact}

- {% include step_label.html id="s046" %} Espera a que los EndpointSlices vuelvan a contener direcciones y repite la consulta DNS.

  > **Nota:** La recuperación no se considera completa hasta validar el síntoma original desde el mismo cliente.
  {: .lab-note .info .compact}

  > **Salida esperada:** Los endpoints reaparecen y `kubernetes.default` vuelve a resolver.
  {: .lab-note .output .compact}

{% capture r5 %}{{ results[4] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r5 %}

{% include support-prompt.html task="tarea5" %}

---

## 🔧 Tarea 6. Troubleshooting: Service sin conectividad — 7 min

Ahora provocarás una falla en el selector de `web-svc`. Los Pods seguirán sanos y la red Pod-to-Pod continuará funcionando, pero la ClusterIP no tendrá backends.

### Tarea 6.1. Introducir el fallo


{% assign tracking_task_id = "t006" %}

- {% include step_label.html id="s047" %} Guarda el Service funcional antes de modificarlo. Puedes usar el nombre **web-svc.before.yaml**

  > **Nota:** Conservar el estado conocido como bueno facilita comparar el selector original con el estado defectuoso.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se crea `web-svc.before.yaml`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s048" %} Cambia el selector de `web-svc` a una label inexistente.

  > **Advertencia:** No modifiques los Pods `web`. El escenario requiere que los backends permanezcan sanos mientras el Service pierde su asociación con ellos.
  {: .lab-note .warning .compact}

  > **Salida esperada:** Kubernetes confirma que el Service fue actualizado.
  {: .lab-note .output .compact}

- {% include step_label.html id="s049" %} Intenta acceder al Service desde `net-client`.

  > **Nota:** Observa el síntoma sin asumir todavía la causa. Una ClusterIP sin backends puede producir timeout o rechazo según el entorno.
  {: .lab-note .info .compact}

  > **Salida esperada:** La solicitud no obtiene la página de NGINX.
  {: .lab-note .output .compact}

### Tarea 6.2. Aislar la causa

- {% include step_label.html id="s050" %} Comprueba que una IP directa de Pod continúa respondiendo.

  > **Importante:** Si el acceso directo funciona, el CNI está transportando tráfico entre ambos Pods. Esto reduce el área de búsqueda hacia Service y backends.
  {: .lab-note .important .compact}

  > **Salida esperada:** NGINX responde correctamente mediante la IP del Pod.
  {: .lab-note .output .compact}

- {% include step_label.html id="s051" %} Examina el selector de `web-svc` y las labels de `web`.

  > **Nota:** Debes buscar una diferencia entre lo que selecciona el Service y lo que realmente anuncian los Pods.
  {: .lab-note .info .compact}

  > **Salida esperada:** El Service utiliza `app=web-broken`, mientras los Pods tienen `app=web`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s052" %} Consulta los EndpointSlices de `web-svc`.

  > **Nota:** Un Service sin endpoints confirma que kube-proxy no dispone de backends seleccionados para ese Service.
  {: .lab-note .info .compact}

  > **Salida esperada:** No existen direcciones backend disponibles.
  {: .lab-note .output .compact}

### Tarea 6.3. Corregir y verificar

- {% include step_label.html id="s053" %} Restaura el selector que coincide con los Pods.

  > **Nota:** La corrección debe limitarse al selector identificado como defectuoso.
  {: .lab-note .info .compact}

  > **Salida esperada:** Kubernetes confirma la actualización.
  {: .lab-note .output .compact}

- {% include step_label.html id="s054" %} Comprueba que los endpoints reaparecieron.

  > **Nota:** Antes de probar la aplicación confirma que el plano de control reconstruyó la asociación Service → Pods.
  {: .lab-note .info .compact}

  > **Salida esperada:** Las IP de los Pods `web` vuelven a aparecer.
  {: .lab-note .output .compact}

- {% include step_label.html id="s055" %} Repite el acceso mediante el Service.

  > **Nota:** Siempre valida una corrección reproduciendo exactamente la operación que originalmente falló.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se obtiene nuevamente la página de NGINX.
  {: .lab-note .output .compact}

{% capture r6 %}{{ results[5] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r6 %}

{% include support-prompt.html task="tarea6" %}

---

## 🚧 Tarea 7. Troubleshooting: conectividad bloqueada por política del CNI — 10 min

En este escenario el Service, los EndpointSlices y los Pods permanecerán correctos, pero una NetworkPolicy impedirá el tráfico hacia la aplicación. Esto permite diagnosticar una restricción aplicada por el CNI sin detener el plugin de red del clúster.

### Tarea 7.1. Introducir la restricción


{% assign tracking_task_id = "t007" %}

- {% include step_label.html id="s056" %} Confirma que el recurso NetworkPolicy está disponible en la API.

  > **Nota:** Kubernetes define el objeto NetworkPolicy, pero su aplicación efectiva depende del plugin de red. En este laboratorio se parte de un CNI con soporte de políticas.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se muestra el recurso `networkpolicies`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s057" %} Crea una política que seleccione los Pods `web` y niegue todo tráfico ingress hacia ellos. Puedes usar el nombre **deny-web-ingress.yaml**

  > **Importante:** Una NetworkPolicy con `policyTypes: [Ingress]` y sin reglas `ingress` aísla para tráfico entrante a los Pods seleccionados.
  {: .lab-note .important .compact}

  > **Salida esperada:** `networkpolicy.networking.k8s.io/deny-web-ingress created`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s058" %} Intenta acceder nuevamente a `web-svc`.

  > **Nota:** El Service y sus endpoints siguen existiendo; el nuevo síntoma se produce porque el CNI debe aplicar la política sobre el tráfico dirigido a los Pods.
  {: .lab-note .info .compact}

  > **Salida esperada:** La solicitud expira o no logra conectarse.
  {: .lab-note .output .compact}

### Tarea 7.2. Diagnosticar la ruta de tráfico

- {% include step_label.html id="s059" %} Confirma que `web-svc` todavía tiene backends.

  > **Importante:** Si los EndpointSlices continúan mostrando Pods sanos, no debes corregir el selector del Service como en el escenario anterior.
  {: .lab-note .important .compact}

  > **Salida esperada:** Las IP de los Pods `web` siguen presentes.
  {: .lab-note .output .compact}

- {% include step_label.html id="s060" %} Prueba directamente la IP del Pod.

  > **Nota:** En este escenario incluso la ruta directa al backend debe estar afectada porque la política selecciona al Pod destino.
  {: .lab-note .info .compact}

  > **Salida esperada:** La conexión directa tampoco obtiene respuesta.
  {: .lab-note .output .compact}

- {% include step_label.html id="s061" %} Lista las NetworkPolicies existentes en `net-lab`.

  > **Nota:** Cuando Service y endpoints son correctos pero el tráfico directo al Pod falla, revisar políticas es una parte natural del flujo de diagnóstico.
  {: .lab-note .info .compact}

  > **Salida esperada:** Aparece `deny-web-ingress`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s062" %} Describe la política y determina qué Pods selecciona y qué dirección de tráfico restringe.

  > **Importante:** No elimines la política hasta poder explicar por qué bloquea `net-client → web`.
  {: .lab-note .important .compact}

  > **Salida esperada:** La política selecciona `app=web`, afecta `Ingress` y no contiene reglas que permitan fuentes.
  {: .lab-note .output .compact}

### Tarea 7.3. Recuperar conectividad aplicando mínimo acceso

En lugar de eliminar directamente la política, crearás una regla que permita únicamente al cliente identificado con una label acceder a NGINX.

- {% include step_label.html id="s063" %} Etiqueta `net-client` para convertirlo en una fuente explícitamente autorizable.

  > **Nota:** Utilizar labels permite expresar la intención de la política sin depender de IPs temporales de Pods.
  {: .lab-note .info .compact}

  > **Salida esperada:** `pod/net-client labeled`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s064" %} Crea una política que permita ingress desde Pods con `access=web` hacia TCP/80 de los Pods `web`. Puedes usar el nombre **allow-web-from-client.yaml**

  > **Nota:** Las políticas son aditivas. La existencia de una política deny-all no impide que otra NetworkPolicy agregue tráfico permitido para los mismos Pods.
  {: .lab-note .info .compact}

  > **Salida esperada:** `networkpolicy.networking.k8s.io/allow-web-from-client created`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s065" %} Repite la solicitud desde `net-client`.

  > **Importante:** Esta prueba confirma que el CNI está aplicando tanto la restricción como la excepción definida mediante NetworkPolicy.
  {: .lab-note .important .compact}

  > **Salida esperada:** NGINX vuelve a responder desde `net-client`.
  {: .lab-note .output .compact}

{% capture r7 %}{{ results[6] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r7 %}

{% include support-prompt.html task="tarea7" %}

---

## ✅ Tarea 8. Recuperar y validar completamente la red — 8 min

Cerrarás la práctica comprobando las tres capas utilizadas durante el troubleshooting: conectividad directa, Service proxy y DNS.

### Tarea 8.1. Validar Pod-to-Pod y Service


{% assign tracking_task_id = "t008" %}

- {% include step_label.html id="s066" %} Comprueba nuevamente la ruta directa hacia el backend.

  > **Nota:** La conectividad directa valida que el CNI permite el tráfico desde el cliente autorizado hacia el Pod `web`.
  {: .lab-note .info .compact}

  > **Salida esperada:** Se recibe contenido HTML.
  {: .lab-note .output .compact}

- {% include step_label.html id="s067" %} Comprueba la ruta mediante `web-svc`.

  > **Nota:** Esta segunda prueba agrega el Service y su mecanismo de proxy al camino de tráfico.
  {: .lab-note .info .compact}

  > **Salida esperada:** El Service entrega contenido de NGINX.
  {: .lab-note .output .compact}

- {% include step_label.html id="s068" %} Confirma que los EndpointSlices continúan asociados correctamente.

  > **Nota:** Una validación final debe comprobar no solo el resultado de usuario, sino también que la relación Service → backends sea coherente.
  {: .lab-note .info .compact}


  > **Salida esperada:** Se muestran los endpoints de `web`.
  {: .lab-note .output .compact}

### Tarea 8.2. Validar DNS y componentes del sistema

- {% include step_label.html id="s069" %} Comprueba que DNS puede resolver nuevamente el Service.

  > **Nota:** Esta prueba confirma que la corrección aplicada a `kube-dns` permanece funcional después de los demás escenarios.
  {: .lab-note .info .compact}

  > **Salida esperada:** El FQDN resuelve correctamente.
  {: .lab-note .output .compact}

- {% include step_label.html id="s070" %} Revisa CoreDNS y kube-proxy una última vez.

  > **Nota:** Los componentes deben terminar la práctica en un estado equivalente a la línea base inicial.
  {: .lab-note .info .compact}

  > **Salida esperada:** CoreDNS y kube-proxy aparecen operativos.
  {: .lab-note .output .compact}

- {% include step_label.html id="s071" %} Comprueba el estado de los nodos.

  > **Nota:** Esta validación final confirma que las pruebas de troubleshooting no dejaron efectos sobre la salud general del clúster.
  {: .lab-note .info .compact}

  > **Salida esperada:** Los nodos permanecen `Ready`.
  {: .lab-note .output .compact}

### Tarea 8.3. Limpiar el escenario de laboratorio

> **Advertencia:** Ejecuta la limpieza únicamente después de validar todos los escenarios. Eliminar `net-lab` también eliminará los Pods, Services y NetworkPolicies utilizados como evidencia.
{: .lab-note .warning .compact}

- {% include step_label.html id="s072" %} Elimina el namespace `net-lab`.

  > **Nota:** Al eliminar el namespace se retiran conjuntamente los workloads y las políticas creadas para el troubleshooting.
  {: .lab-note .info .compact}

  > **Salida esperada:** Kubernetes confirma la eliminación de `net-lab`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s073" %} Confirma que el Service DNS conserva el selector correcto.

  > **Importante:** `kube-dns` pertenece a `kube-system` y no se elimina con `net-lab`; por eso debes verificar que la configuración temporal del escenario 5 quedó completamente revertida.
  {: .lab-note .important .compact}

  > **Salida esperada:** El selector contiene `k8s-app:kube-dns`.
  {: .lab-note .output .compact}

- {% include step_label.html id="s074" %} Ejecuta una última revisión del namespace `kube-system`.

  > **Nota:** La práctica finaliza únicamente cuando los componentes de infraestructura siguen funcionando normalmente.
  {: .lab-note .info .compact}
  
  > **Salida esperada:** Los componentes esenciales se encuentran `Running` y no aparecen errores derivados de los escenarios realizados.
  {: .lab-note .output .compact}

{% capture r8 %}{{ results[7] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r8 %}

{% include support-prompt.html task="tarea8" %}
