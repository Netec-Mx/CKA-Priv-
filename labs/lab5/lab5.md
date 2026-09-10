---
layout: lab
title: "Práctica 5: Backup y restore de etcd"
permalink: /lab5/lab5/
images_base: /labs/lab5/img
duration: "60 minutos"
objective:
  - Crear, validar y restaurar un snapshot de etcd en un clúster Kubernetes administrado con kubeadm, comprobando que el estado del clúster regresa al punto respaldado.
prerequisites:
  - Haber completado la Práctica 4 y disponer del clúster CKA operativo con el nodo control-plane en estado Ready.
  - Tener kubectl configurado con acceso administrativo al clúster.
  - Disponer de acceso de terminal con privilegios sudo al nodo control-plane.
  - Tener disponibles etcdctl y etcdutl en el nodo control-plane.
  - Trabajar desde Visual Studio Code utilizando Git Bash como terminal principal.
  - Utilizar un clúster de laboratorio, ya que durante la restauración el API Server dejará de responder temporalmente.
introduction:
  - En esta práctica recorrerás el ciclo completo de respaldo y recuperación de etcd. Identificarás cómo se ejecuta etcd, crearás un punto de referencia antes del snapshot, generarás y validarás el respaldo, crearás información posterior al backup y después restaurarás etcd hacia un nuevo directorio de datos. Finalmente comprobarás que Kubernetes regresó exactamente al estado almacenado en el snapshot.
slug: lab5
lab_number: 5
final_result: >
  Al finalizar habrás creado y validado un snapshot de etcd, restaurado el estado del clúster mediante etcdutl, reconfigurado el static Pod de etcd para utilizar el directorio restaurado y comprobado que los objetos existentes al momento del snapshot permanecen, mientras que los creados posteriormente dejan de existir.
notes:
  - etcd almacena el estado persistente de Kubernetes. Un snapshot puede incluir Secrets y otros datos sensibles, por lo que debe protegerse como información crítica del clúster.
  - La práctica asume un control plane creado con kubeadm y etcd ejecutándose como static Pod mediante /etc/kubernetes/manifests/etcd.yaml.
  - etcdctl se utilizará para crear el snapshot y etcdutl para consultar su estado y restaurarlo.
  - Los pasos identificados como CONTROL-PLANE deben ejecutarse dentro del nodo control-plane con privilegios sudo.
  - No elimines los respaldos hasta finalizar todas las validaciones.
references:
  - text: Operating etcd clusters for Kubernetes
    url: https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/
  - text: etcd Disaster recovery
    url: https://etcd.io/docs/v3.7/op-guide/recovery/
  - text: etcd snapshot database
    url: https://etcd.io/docs/v3.6/tasks/operator/how-to-save-database/
prev: /lab4/lab4/
next: /lab6/lab6/
---

---

<!-- Aquí comienzan las instrucciones paso a paso de la práctica -->

## 🔎 Tarea 1. Identificar etcd y preparar el punto de recuperación — 7 min

Antes de respaldar etcd necesitas confirmar dónde se ejecuta, cómo está desplegado y qué datos formarán parte del snapshot.

### Tarea 1.1. Identificar el nodo control-plane

Primero confirmarás el estado general del clúster y localizarás el nodo que ejecuta los componentes del control plane.

> **Nota:** etcd suele ejecutarse en los nodos control-plane. En esta práctica se utiliza un único miembro etcd local, como es habitual en clústeres de laboratorio creados con kubeadm.
{: .lab-note .info .compact}

- {% include step_label.html %} Consulta los nodos para identificar el control-plane y verificar que el clúster está estable antes de iniciar.

  > **Nota:** Este paso confirma que el clúster está operativo y permite identificar el nodo que ejecuta el control plane.
  {: .lab-note .info .compact}

  ```bash
  kubectl get nodes -o wide
  ```

  > **Salida esperada:** El nodo control-plane y los workers aparecen en estado `Ready`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Guarda automáticamente el nombre del nodo control-plane en una variable.

  > **Nota:** Guardar el nombre evita escribirlo manualmente en pasos posteriores y reduce errores de selección.
  {: .lab-note .info .compact}

  ```bash
  CONTROL_PLANE=$(kubectl get nodes \
    -l node-role.kubernetes.io/control-plane \
    -o jsonpath='{.items[0].metadata.name}')
  ```

- {% include step_label.html %} Muestra la variable para confirmar qué nodo usarás durante la práctica.

  > **Nota:** Verifica el valor antes de continuar para asegurarte de que trabajarás sobre el nodo correcto.
  {: .lab-note .info .compact}

  ```bash
  echo "$CONTROL_PLANE"
  ```

  > **Salida esperada:** Se muestra el nombre del nodo control-plane.
  {: .lab-note .output .compact}

### Tarea 1.2. Identificar cómo se ejecuta etcd

Ahora revisarás la configuración local del nodo control-plane.

> **Importante:** A partir de este punto, cuando se indique **CONTROL-PLANE**, el comando debe ejecutarse dentro del nodo control-plane y no desde Git Bash en tu estación de trabajo.
{: .lab-note .important .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Comprueba que el manifiesto estático de etcd existe.

  > **Nota:** Este archivo define cómo kubelet ejecuta etcd como static Pod en el nodo control-plane.
  {: .lab-note .info .compact}

  ```bash
  sudo ls -l /etc/kubernetes/manifests/etcd.yaml
  ```

  > **Salida esperada:** Se muestra `/etc/kubernetes/manifests/etcd.yaml`.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Revisa los parámetros principales usados por etcd.

  > **Nota:** Estos valores permiten reconocer la ubicación de los datos y la configuración que deberá conservarse durante la restauración.
  {: .lab-note .info .compact}

  ```bash
  sudo grep -E -- \
    '--name=|--data-dir=|--listen-client-urls=|--advertise-client-urls=|--initial-cluster=' \
    /etc/kubernetes/manifests/etcd.yaml
  ```

  > **Salida esperada:** Se observan parámetros como `--data-dir=/var/lib/etcd` y los endpoints de cliente y peer.
  {: .lab-note .output .compact}

- {% include step_label.html %} Regresa a Git Bash y verifica el Pod de etcd desde Kubernetes.

  > **Nota:** La consulta confirma desde Kubernetes que etcd está activo y asociado al control-plane.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pods -n kube-system -l component=etcd -o wide
  ```

  > **Salida esperada:** El Pod de etcd aparece `Running`.
  {: .lab-note .output .compact}

### Tarea 1.3. Crear el estado que deberá recuperarse

Crearás información antes del snapshot. Este recurso será tu evidencia de que el restore regresó al punto correcto.

> **Importante:** Todo objeto creado antes del snapshot debe reaparecer después del restore. Los objetos creados después del snapshot no deberían formar parte del estado recuperado.
{: .lab-note .important .compact}

- {% include step_label.html %} Crea el namespace `etcd-before`.

  > **Nota:** Este namespace formará parte del estado almacenado en el snapshot y servirá como referencia durante la recuperación.
  {: .lab-note .info .compact}

  ```bash
  kubectl create namespace etcd-before
  ```

  > **Salida esperada:** `namespace/etcd-before created`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Crea un ConfigMap que identifique explícitamente el estado anterior al snapshot.

  > **Nota:** El ConfigMap funciona como marcador para comprobar posteriormente que el estado previo al snapshot fue recuperado.
  {: .lab-note .info .compact}

  ```bash
  kubectl create configmap recovery-marker \
    --from-literal=state=before-snapshot \
    -n etcd-before
  ```

  > **Salida esperada:** `configmap/recovery-marker created`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba el valor guardado.

  > **Nota:** Esta validación establece el contenido exacto que deberá reaparecer después del restore.
  {: .lab-note .info .compact}

  ```bash
  kubectl get configmap recovery-marker \
    -n etcd-before \
    -o jsonpath='{.data.state}{"\n"}'
  ```

  > **Salida esperada:** `before-snapshot`.
  {: .lab-note .output .compact}

{% assign results = site.data.task-results[page.slug].results %}
{% capture r1 %}{{ results[0] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r1 %}

{% include support-prompt.html task="tarea1" %}

---

## 🧰 Tarea 2. Preparar herramientas, certificados y ubicación del backup — 6 min

etcd utiliza TLS. Antes de conectarte directamente debes conocer el endpoint y utilizar certificados válidos.

### Tarea 2.1. Verificar las herramientas necesarias

> **Nota:** `etcdctl` interactúa con un etcd en ejecución. `etcdutl` trabaja con snapshots y directorios de datos fuera de línea.
{: .lab-note .info .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Verifica la versión de `etcdctl`.

  > **Nota:** Confirma que la herramienta usada para crear el snapshot está disponible en el nodo.
  {: .lab-note .info .compact}

  ```bash
  etcdctl version
  ```

  > **Salida esperada:** Se muestra la versión de `etcdctl`.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Verifica la versión de `etcdutl`.

  > **Nota:** Confirma que la herramienta usada para validar y restaurar snapshots está disponible.
  {: .lab-note .info .compact}

  ```bash
  etcdutl version
  ```

  > **Salida esperada:** Se muestra la versión de `etcdutl`.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Confirma la ubicación de ambas herramientas.

  > **Nota:** Verifica que el shell puede localizar ambos ejecutables desde el PATH.
  {: .lab-note .info .compact}

  ```bash
  command -v etcdctl && command -v etcdutl
  ```

  > **Salida esperada:** Se muestran las rutas de `etcdctl` y `etcdutl`.
  {: .lab-note .output .compact}

### Tarea 2.2. Preparar el acceso TLS a etcd

> **Advertencia:** Los certificados utilizados en este procedimiento permiten autenticarse contra etcd. No los copies fuera del nodo ni los agregues a repositorios.
{: .lab-note .warning .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Define las variables con el endpoint y los certificados.

  > **Nota:** Estas variables concentran los parámetros TLS necesarios para autenticarse directamente contra etcd.
  {: .lab-note .info .compact}

  ```bash
  export ETCD_ENDPOINT="https://127.0.0.1:2379"
  export ETCD_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
  export ETCD_CERT="/etc/kubernetes/pki/etcd/healthcheck-client.crt"
  export ETCD_KEY="/etc/kubernetes/pki/etcd/healthcheck-client.key"
  ```

- {% include step_label.html %} **CONTROL-PLANE:** Confirma que los archivos realmente existen.

  > **Nota:** Valida las rutas de certificados antes de intentar una conexión TLS.
  {: .lab-note .info .compact}

  ```bash
  sudo ls -l \
    "$ETCD_CACERT" \
    "$ETCD_CERT" \
    "$ETCD_KEY"
  ```

  > **Salida esperada:** Los tres archivos son visibles.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Verifica la salud de etcd usando TLS.

  > **Nota:** Antes del backup debes confirmar que el miembro etcd responde correctamente.
  {: .lab-note .info .compact}

  ```bash
  sudo etcdctl \
    --endpoints="$ETCD_ENDPOINT" \
    --cacert="$ETCD_CACERT" \
    --cert="$ETCD_CERT" \
    --key="$ETCD_KEY" \
    endpoint health
  ```

  > **Salida esperada:** El endpoint informa que está saludable.
  {: .lab-note .output .compact}

### Tarea 2.3. Preparar una ruta segura para el snapshot

> **Importante:** El backup se guardará fuera de `/var/lib/etcd`. No conviene almacenar una copia de recuperación dentro del mismo directorio activo que estás protegiendo.
{: .lab-note .important .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Crea el directorio de respaldos.

  > **Nota:** El snapshot se guardará fuera del directorio activo de etcd para mantener separado el respaldo.
  {: .lab-note .info .compact}

  ```bash
  sudo mkdir -p /opt/cka-backups
  ```

- {% include step_label.html %} **CONTROL-PLANE:** Define el nombre del archivo de snapshot.

  > **Nota:** La variable simplifica los comandos posteriores y reduce errores al repetir la ruta.
  {: .lab-note .info .compact}

  ```bash
  export SNAPSHOT="/opt/cka-backups/etcd-lab5.db"
  ```

- {% include step_label.html %} **CONTROL-PLANE:** Asegúrate de no sobrescribir un snapshot previo.

  > **Nota:** Evitar sobrescrituras protege respaldos anteriores que podrían ser necesarios.
  {: .lab-note .info .compact}

  ```bash
  sudo test ! -e "$SNAPSHOT" && echo "Ruta de snapshot disponible"
  ```

  > **Salida esperada:** `Ruta de snapshot disponible`.
  {: .lab-note .output .compact}

{% capture r2 %}{{ results[1] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r2 %}

{% include support-prompt.html task="tarea2" %}

---

## 💾 Tarea 3. Crear el snapshot de etcd — 7 min

Ahora generarás una copia coherente de la base de datos mientras etcd continúa operativo.

### Tarea 3.1. Registrar el momento del backup

- {% include step_label.html %} **CONTROL-PLANE:** Guarda la fecha y hora del respaldo.

  > **Nota:** Registrar el momento del backup ayuda a identificar con precisión el punto de recuperación.
  {: .lab-note .info .compact}

  ```bash
  date -Is | sudo tee /opt/cka-backups/etcd-lab5.timestamp
  ```

  > **Salida esperada:** Se muestra una fecha en formato ISO 8601.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Comprueba nuevamente la salud de etcd.

  > **Nota:** Realiza una última validación antes de solicitar el snapshot.
  {: .lab-note .info .compact}

  ```bash
  sudo etcdctl \
    --endpoints="$ETCD_ENDPOINT" \
    --cacert="$ETCD_CACERT" \
    --cert="$ETCD_CERT" \
    --key="$ETCD_KEY" \
    endpoint health
  ```

  > **Salida esperada:** etcd responde como saludable.
  {: .lab-note .output .compact}

### Tarea 3.2. Guardar el snapshot

> **Importante:** `snapshot save` solicita a etcd una copia consistente de la base de datos. Esta es la forma adecuada de generar el respaldo en línea.
{: .lab-note .important .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Crea el snapshot.

  > **Nota:** etcdctl solicitará una copia consistente del estado confirmado por etcd en ese momento.
  {: .lab-note .info .compact}

  ```bash
  sudo etcdctl \
    --endpoints="$ETCD_ENDPOINT" \
    --cacert="$ETCD_CACERT" \
    --cert="$ETCD_CERT" \
    --key="$ETCD_KEY" \
    snapshot save "$SNAPSHOT"
  ```

  > **Salida esperada:** etcdctl confirma que el snapshot fue guardado.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Comprueba que el archivo fue creado y tiene contenido.

  > **Nota:** Comprueba que el snapshot existe físicamente y contiene datos.
  {: .lab-note .info .compact}

  ```bash
  sudo ls -lh "$SNAPSHOT"
  ```

  > **Salida esperada:** Se muestra `/opt/cka-backups/etcd-lab5.db`.
  {: .lab-note .output .compact}

### Tarea 3.3. Crear una copia adicional del respaldo

> **Nota:** Mantener una copia sin modificar es útil si necesitas repetir el procedimiento de restore.
{: .lab-note .info .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Duplica el snapshot.

  > **Nota:** Conservar una copia intacta permite repetir la restauración sin reutilizar el mismo archivo de trabajo.
  {: .lab-note .info .compact}

  ```bash
  sudo cp "$SNAPSHOT" /opt/cka-backups/etcd-lab5-original.db
  ```

- {% include step_label.html %} **CONTROL-PLANE:** Compara los hashes.

  > **Nota:** Hashes idénticos confirman que ambas copias contienen exactamente la misma información.
  {: .lab-note .info .compact}

  ```bash
  sudo sha256sum \
    /opt/cka-backups/etcd-lab5.db \
    /opt/cka-backups/etcd-lab5-original.db
  ```

  > **Salida esperada:** Ambos hashes son idénticos.
  {: .lab-note .output .compact}

{% capture r3 %}{{ results[2] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r3 %}

{% include support-prompt.html task="tarea3" %}

---

## ✅ Tarea 4. Validar el snapshot — 5 min

Un archivo existente no garantiza que el respaldo sea utilizable. Antes de restaurarlo revisarás su metadata.

### Tarea 4.1. Consultar el estado del snapshot

> **Importante:** En etcd moderno, `snapshot status` se ejecuta con `etcdutl`.
{: .lab-note .important .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Consulta el snapshot en formato tabla.

  > **Nota:** La metadata permite comprobar que el archivo puede ser leído antes de depender de él para una recuperación.
  {: .lab-note .info .compact}

  ```bash
  sudo etcdutl snapshot status "$SNAPSHOT" --write-out=table
  ```

  > **Salida esperada:** Se muestran `HASH`, `REVISION`, `TOTAL KEYS` y `TOTAL SIZE`.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Guarda la misma información en JSON.

  > **Nota:** El formato JSON conserva evidencia estructurada del snapshot para revisiones posteriores.
  {: .lab-note .info .compact}

  ```bash
  sudo etcdutl snapshot status "$SNAPSHOT" --write-out=json \
    | sudo tee /opt/cka-backups/etcd-lab5-status.json
  ```

  > **Salida esperada:** Se crea `etcd-lab5-status.json`.
  {: .lab-note .output .compact}

### Tarea 4.2. Confirmar el punto de referencia antes del restore

- {% include step_label.html %} Regresa a Git Bash y comprueba que el ConfigMap anterior al snapshot sigue presente.

  > **Nota:** Confirma que el marcador previo al backup sigue disponible antes de modificar el estado del clúster.
  {: .lab-note .info .compact}

  ```bash
  kubectl get configmap recovery-marker -n etcd-before
  ```

  > **Salida esperada:** `recovery-marker` existe.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta el valor almacenado.

  > **Nota:** Este valor será comparado con el resultado después de la restauración.
  {: .lab-note .info .compact}

  ```bash
  kubectl get configmap recovery-marker \
    -n etcd-before \
    -o jsonpath='{.data.state}{"\n"}'
  ```

  > **Salida esperada:** `before-snapshot`.
  {: .lab-note .output .compact}

{% capture r4 %}{{ results[3] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r4 %}

{% include support-prompt.html task="tarea4" %}

---

## 🧪 Tarea 5. Crear estado posterior al snapshot — 5 min

Ahora generarás información que **no** existe dentro del backup.

### Tarea 5.1. Crear recursos posteriores al respaldo

> **Nota:** Estos objetos permiten demostrar visualmente que el restore realmente retrocede el estado de Kubernetes.
{: .lab-note .info .compact}

- {% include step_label.html %} Crea el namespace `etcd-after`.

  > **Nota:** Este objeto se crea después del snapshot y debe desaparecer cuando el estado sea restaurado.
  {: .lab-note .info .compact}

  ```bash
  kubectl create namespace etcd-after
  ```

  > **Salida esperada:** `namespace/etcd-after created`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Crea un ConfigMap dentro del nuevo namespace.

  > **Nota:** El segundo marcador representa información que no existe dentro del snapshot.
  {: .lab-note .info .compact}

  ```bash
  kubectl create configmap recovery-marker \
    --from-literal=state=after-snapshot \
    -n etcd-after
  ```

  > **Salida esperada:** `configmap/recovery-marker created`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Confirma su valor.

  > **Nota:** Verifica que el estado posterior al backup quedó realmente almacenado antes de iniciar la recuperación.
  {: .lab-note .info .compact}

  ```bash
  kubectl get configmap recovery-marker \
    -n etcd-after \
    -o jsonpath='{.data.state}{"\n"}'
  ```

  > **Salida esperada:** `after-snapshot`.
  {: .lab-note .output .compact}

### Tarea 5.2. Comparar ambos estados

- {% include step_label.html %} Comprueba que ambos namespaces existen.

  > **Nota:** Esta consulta establece claramente el estado actual antes del restore.
  {: .lab-note .info .compact}

  ```bash
  kubectl get namespaces etcd-before etcd-after
  ```

  > **Salida esperada:** Ambos namespaces aparecen `Active`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Lista los dos marcadores.

  > **Nota:** La comparación conjunta permite distinguir los datos anteriores y posteriores al snapshot.
  {: .lab-note .info .compact}

  ```bash
  kubectl get configmaps -A \
    --field-selector metadata.name=recovery-marker
  ```

  > **Salida esperada:** Se observan los marcadores en `etcd-before` y `etcd-after`.
  {: .lab-note .output .compact}

{% capture r5 %}{{ results[4] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r5 %}

{% include support-prompt.html task="tarea5" %}

---

## 🧭 Tarea 6. Preparar la restauración — 7 min

Antes de restaurar necesitas conocer la identidad y configuración peer del miembro etcd actual.

### Tarea 6.1. Obtener los parámetros del miembro

> **Importante:** Estos valores deben corresponder al miembro actual. No inventes direcciones ni nombres, porque el directorio restaurado debe mantener la topología correcta del clúster.
{: .lab-note .important .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Extrae el nombre del miembro.

  > **Nota:** El nombre del miembro restaurado debe coincidir con la configuración utilizada por el etcd actual.
  {: .lab-note .info .compact}

  ```bash
  export ETCD_NAME=$(sudo awk -F= \
    '/--name=/{gsub(/[", ]/,"",$2); print $2; exit}' \
    /etc/kubernetes/manifests/etcd.yaml)
  ```

- {% include step_label.html %} **CONTROL-PLANE:** Extrae la configuración `initial-cluster`.

  > **Nota:** Este valor describe la membresía y las URLs peer utilizadas por el clúster etcd.
  {: .lab-note .info .compact}

  ```bash
  export ETCD_INITIAL_CLUSTER=$(sudo sed -n \
  's/^[[:space:]]*-[[:space:]]*--initial-cluster=//p' \
  /etc/kubernetes/manifests/etcd.yaml)
  ```

- {% include step_label.html %} **CONTROL-PLANE:** Extrae la URL peer anunciada.

  > **Nota:** La URL peer se reutilizará para reconstruir correctamente la identidad del miembro.
  {: .lab-note .info .compact}

  ```bash
  export ETCD_PEER_URL=$(sudo awk -F= \
    '/--initial-advertise-peer-urls=/{gsub(/[", ]/,"",$2); print $2; exit}' \
    /etc/kubernetes/manifests/etcd.yaml)
  ```

- {% include step_label.html %} **CONTROL-PLANE:** Muestra los valores obtenidos.

  > **Nota:** Revisar los parámetros antes del restore ayuda a detectar valores vacíos o incorrectos.
  {: .lab-note .info .compact}

  ```bash
  printf 'NAME=%s\nINITIAL_CLUSTER=%s\nPEER_URL=%s\n' \
    "$ETCD_NAME" "$ETCD_INITIAL_CLUSTER" "$ETCD_PEER_URL"
  ```

  > **Salida esperada:** Los valores coinciden con el static Pod actual.
  {: .lab-note .output .compact}

### Tarea 6.2. Proteger el manifiesto original

> **Advertencia:** No guardes una copia YAML dentro de `/etc/kubernetes/manifests`. kubelet podría interpretar cualquier manifiesto adicional en esa carpeta como otro static Pod.
{: .lab-note .warning .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Copia el manifiesto original fuera de la carpeta observada por kubelet.

  > **Nota:** Guardar una copia permite recuperar rápidamente la configuración previa si fuera necesario.
  {: .lab-note .info .compact}

  ```bash
  sudo cp /etc/kubernetes/manifests/etcd.yaml \
    /opt/cka-backups/etcd.yaml.before-restore
  ```

- {% include step_label.html %} **CONTROL-PLANE:** Verifica la copia.

  > **Nota:** No continúes hasta confirmar que el manifiesto original quedó protegido fuera de la carpeta observada por kubelet.
  {: .lab-note .info .compact}

  ```bash
  sudo ls -l /opt/cka-backups/etcd.yaml.before-restore
  ```

  > **Salida esperada:** Se muestra el archivo respaldado.
  {: .lab-note .output .compact}

### Tarea 6.3. Definir el directorio restaurado

- {% include step_label.html %} **CONTROL-PLANE:** Define un directorio nuevo para el restore.

  > **Nota:** La restauración se realizará en una ruta distinta para evitar sobrescribir de inmediato los datos activos.
  {: .lab-note .info .compact}

  ```bash
  export RESTORE_DIR="/var/lib/etcd-restore"
  ```

- {% include step_label.html %} **CONTROL-PLANE:** Comprueba que no exista una restauración previa.

  > **Nota:** etcdutl debe trabajar sobre un destino limpio para evitar mezclar información de restauraciones anteriores.
  {: .lab-note .info .compact}

  ```bash
  sudo test ! -e "$RESTORE_DIR" && echo "Directorio de restore disponible"
  ```

  > **Salida esperada:** `Directorio de restore disponible`.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Verifica que el directorio activo original continúa intacto.

  > **Nota:** Este control confirma que la base de datos actual todavía no ha sido alterada.
  {: .lab-note .info .compact}

  ```bash
  sudo ls -ld /var/lib/etcd
  ```

  > **Salida esperada:** `/var/lib/etcd` existe.
  {: .lab-note .output .compact}

{% capture r6 %}{{ results[5] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r6 %}

{% include support-prompt.html task="tarea6" %}

---

## ♻️ Tarea 7. Restaurar etcd desde el snapshot — 9 min

Esta es la fase más sensible de la práctica. Primero crearás el nuevo directorio restaurado y después harás que el static Pod de etcd utilice esos datos.

### Tarea 7.1. Restaurar el snapshot

> **Importante:** `etcdutl snapshot restore` no modifica el etcd en ejecución. Construye un nuevo directorio de datos a partir del snapshot.
{: .lab-note .important .compact}

> **Nota:** `--bump-revision` y `--mark-compacted` ayudan a que los watchers de Kubernetes detecten correctamente el cambio de estado después de la restauración.
{: .lab-note .info .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Ejecuta la restauración hacia el nuevo directorio.

  > **Nota:** etcdutl reconstruirá un nuevo directorio de datos usando el contenido almacenado en el snapshot.
  {: .lab-note .info .compact}

  ```bash
  sudo etcdutl snapshot restore "$SNAPSHOT" \
    --data-dir="$RESTORE_DIR" \
    --name="$ETCD_NAME" \
    --initial-cluster="$ETCD_INITIAL_CLUSTER" \
    --initial-advertise-peer-urls="$ETCD_PEER_URL" \
    --bump-revision=1000000000 \
    --mark-compacted
  ```

  > **Salida esperada:** La restauración finaliza sin errores.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Revisa la estructura creada.

  > **Nota:** La presencia de `member`, `snap` y `wal` confirma que se generó una estructura de datos utilizable por etcd.
  {: .lab-note .info .compact}

  ```bash
  sudo find "$RESTORE_DIR" -maxdepth 2 -type d -print
  ```

  > **Salida esperada:** Aparecen directorios como `member`, `member/snap` y `member/wal`.
  {: .lab-note .output .compact}

### Tarea 7.2. Cambiar el directorio montado por el static Pod

> **Advertencia:** No cambies `--data-dir=/var/lib/etcd` dentro del contenedor. Solo debes modificar el `hostPath` que kubelet monta en esa ruta.
{: .lab-note .warning .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Localiza el volumen `etcd-data`.

  > **Nota:** Debes identificar exactamente el `hostPath` que conecta los datos del host con el contenedor etcd.
  {: .lab-note .info .compact}

  ```bash
  sudo grep -n -A3 -B2 'etcd-data' \
    /etc/kubernetes/manifests/etcd.yaml
  ```

  > **Salida esperada:** El `hostPath` muestra `path: /var/lib/etcd`.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Cambia la ruta al directorio restaurado.

  > **Nota:** Este cambio hará que kubelet recree etcd utilizando los datos restaurados en lugar de los originales.
  {: .lab-note .info .compact}

  ```bash
  sudo sed -i \
    's#path: /var/lib/etcd$#path: /var/lib/etcd-restore#' \
    /etc/kubernetes/manifests/etcd.yaml
  ```

- {% include step_label.html %} **CONTROL-PLANE:** Confirma el cambio.

  > **Nota:** Verifica la ruta antes de esperar el reinicio para evitar iniciar etcd con un directorio equivocado.
  {: .lab-note .info .compact}

  ```bash
  sudo grep -n -A3 -B2 'etcd-data' \
    /etc/kubernetes/manifests/etcd.yaml
  ```

  > **Salida esperada:** El `hostPath` muestra `/var/lib/etcd-restore`.
  {: .lab-note .output .compact}

### Tarea 7.3. Observar el reinicio de etcd

> **Advertencia:** El API Server puede quedar temporalmente inaccesible. Mensajes como `connection refused`, `EOF` o errores momentáneos de kubectl son esperables mientras etcd reinicia.
{: .lab-note .warning .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Comprueba si el runtime ya levantó el nuevo contenedor de etcd.

  > **Nota:** crictl permite comprobar el contenedor incluso cuando el API Server todavía no está disponible.
  {: .lab-note .info .compact}

  ```bash
  until sudo crictl ps --name etcd | grep -q etcd; do
    echo "Esperando que etcd reinicie..."
    sleep 2
  done
  ```
  ```bash
  sudo crictl ps --name etcd
  sudo crictl ps -a --name etcd
  ```

  > **Salida esperada:** Aparece un contenedor etcd en ejecución.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Comprueba la salud del nuevo etcd.

  > **Nota:** Primero se valida etcd directamente; después se comprobará la recuperación del resto de Kubernetes.
  {: .lab-note .info .compact}

  ```bash
  sudo etcdctl \
    --endpoints="$ETCD_ENDPOINT" \
    --cacert="$ETCD_CACERT" \
    --cert="$ETCD_CERT" \
    --key="$ETCD_KEY" \
    endpoint health
  ```

  > **Salida esperada:** El endpoint aparece saludable.
  {: .lab-note .output .compact}

{% capture r7 %}{{ results[6] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r7 %}

{% include support-prompt.html task="tarea7" %}

---

## 🩺 Tarea 8. Validar la recuperación del clúster — 8 min

Una vez que etcd está saludable, comprobarás que el API Server y el resto del control plane vuelven a funcionar.

### Tarea 8.1. Confirmar que el API Server responde

> **Nota:** El API Server depende de etcd. Puede tardar algunos segundos en recuperar conectividad después del reinicio.
{: .lab-note .info .compact}

- {% include step_label.html %} Regresa a Git Bash y consulta el endpoint de readiness.

  > **Nota:** El endpoint `readyz` confirma que el API Server volvió a estar preparado para atender solicitudes.
  {: .lab-note .info .compact}

  ```bash
  kubectl get --raw='/readyz'
  ```

  > **Salida esperada:** `ok`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta los nodos.

  > **Nota:** La respuesta confirma que el API Server puede leer nuevamente el estado almacenado en etcd.
  {: .lab-note .info .compact}

  ```bash
  kubectl get nodes
  ```

  > **Salida esperada:** Los nodos aparecen y convergen a `Ready`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa los Pods del sistema.

  > **Nota:** Esta revisión permite comprobar que los componentes del control plane y servicios del clúster se están estabilizando.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pods -n kube-system -o wide
  ```

  > **Salida esperada:** Los componentes principales están `Running` o progresan hacia ese estado.
  {: .lab-note .output .compact}

### Tarea 8.2. Confirmar que regresó el estado del snapshot

> **Importante:** Esta es la prueba funcional del restore. El objetivo no es solo que etcd arranque, sino comprobar que el contenido recuperado corresponde al punto del snapshot.
{: .lab-note .important .compact}

- {% include step_label.html %} Comprueba que `etcd-before` existe.

  > **Nota:** La existencia del namespace demuestra que se recuperó información presente al momento del snapshot.
  {: .lab-note .info .compact}

  ```bash
  kubectl get namespace etcd-before
  ```

  > **Salida esperada:** `etcd-before` aparece `Active`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Verifica el contenido del marcador restaurado.

  > **Nota:** El valor debe coincidir con el registrado antes del backup.
  {: .lab-note .info .compact}

  ```bash
  kubectl get configmap recovery-marker \
    -n etcd-before \
    -o jsonpath='{.data.state}{"\n"}'
  ```

  > **Salida esperada:** `before-snapshot`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba que `etcd-after` ya no existe.

  > **Nota:** Su ausencia confirma que el clúster regresó a un punto anterior a la creación de ese namespace.
  {: .lab-note .info .compact}

  ```bash
  kubectl get namespace etcd-after
  ```

  > **Salida esperada:** Kubernetes responde `NotFound`.
  {: .lab-note .output .compact}

### Tarea 8.3. Revisar estabilidad posterior al restore

- {% include step_label.html %} Consulta eventos recientes.

  > **Nota:** Los eventos ayudan a detectar errores persistentes posteriores a la recuperación.
  {: .lab-note .info .compact}

  ```bash
  kubectl get events -A \
    --sort-by='.lastTimestamp' \
    | tail -n 20
  ```

  > **Salida esperada:** Puede haber eventos de reinicio, pero no fallos persistentes del control plane.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba nuevamente el Pod de etcd.

  > **Nota:** Esta es una validación final de que etcd permanece estable desde la perspectiva de Kubernetes.
  {: .lab-note .info .compact}

  ```bash
  kubectl get pods -n kube-system -l component=etcd
  ```

  > **Salida esperada:** El Pod de etcd aparece `Running`.
  {: .lab-note .output .compact}

{% capture r8 %}{{ results[7] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r8 %}

{% include support-prompt.html task="tarea8" %}

---

## 📋 Tarea 9. Comprobar consistencia y cerrar la práctica — 6 min

Finalizarás comparando el estado recuperado y conservando los archivos necesarios para revisar el procedimiento posteriormente.

### Tarea 9.1. Confirmar la consistencia del estado restaurado

- {% include step_label.html %} Lista los ConfigMaps llamados `recovery-marker`.

  > **Nota:** La consulta resume qué marcador permanece después del restore.
  {: .lab-note .info .compact}

  ```bash
  kubectl get configmaps -A \
    --field-selector metadata.name=recovery-marker
  ```

  > **Salida esperada:** Solo aparece el marcador de `etcd-before`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Intenta consultar explícitamente el marcador posterior al snapshot.

  > **Nota:** La respuesta `NotFound` confirma que los datos posteriores al backup no forman parte del estado recuperado.
  {: .lab-note .info .compact}

  ```bash
  kubectl get configmap recovery-marker -n etcd-after
  ```

  > **Salida esperada:** `NotFound`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Revisa el estado final de nodos y componentes.

  > **Nota:** El objetivo final es recuperar tanto los datos como la operación normal del clúster.
  {: .lab-note .info .compact}

  ```bash
  kubectl get nodes
  ```

  ```bash
  kubectl get pods -n kube-system
  ```

  > **Salida esperada:** Los nodos están `Ready` y los componentes principales están operativos.
  {: .lab-note .output .compact}

### Tarea 9.2. Conservar evidencia y limpiar recursos de prueba

> **Advertencia:** No elimines todavía los archivos bajo `/opt/cka-backups`. Son la evidencia del procedimiento y permiten repetir la recuperación si fuera necesario.
{: .lab-note .warning .compact}

- {% include step_label.html %} Elimina el namespace usado como marcador de prueba.

  > **Nota:** Solo se retira el recurso de prueba; los archivos de respaldo se conservan.
  {: .lab-note .info .compact}

  ```bash
  kubectl delete namespace etcd-before
  ```

  > **Salida esperada:** Kubernetes confirma la eliminación del namespace.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Revisa los archivos de respaldo conservados.

  > **Nota:** Comprueba que la evidencia del backup y del procedimiento sigue disponible.
  {: .lab-note .info .compact}

  ```bash
  sudo ls -lh /opt/cka-backups/
  ```

  > **Salida esperada:** Se muestran los archivos generados durante la práctica.
  {: .lab-note .output .compact}

- {% include step_label.html %} **CONTROL-PLANE:** Confirma qué directorio está usando actualmente etcd.

  > **Nota:** La ruta debe seguir apuntando al directorio restaurado que contiene el estado recuperado.
  {: .lab-note .info .compact}

  ```bash
  sudo grep -n -A3 -B2 'etcd-data' \
    /etc/kubernetes/manifests/etcd.yaml
  ```

  > **Salida esperada:** El `hostPath` muestra `/var/lib/etcd-restore`.
  {: .lab-note .output .compact}

{% capture r9 %}{{ results[8] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r9 %}

{% include support-prompt.html task="tarea9" %}
