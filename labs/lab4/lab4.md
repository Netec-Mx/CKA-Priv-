---
layout: lab
title: "Práctica 4: Configurar acceso administrativo controlado con RBAC"
permalink: /lab4/lab4/
images_base: /labs/lab4/img
duration: "40 minutos"
objective:
  - Configurar y validar acceso administrativo controlado en Kubernetes mediante ServiceAccounts, Roles, ClusterRoles, RoleBindings, ClusterRoleBindings y un kubeconfig temporal, aplicando privilegio mínimo y resolviendo escenarios de autorización parcialmente guiados.
prerequisites:
  - Haber completado la Práctica 3 y disponer del clúster CKA operativo con sus nodos en estado Ready.
  - Tener kubectl configurado con un contexto administrativo funcional contra el clúster.
  - Poder crear namespaces, ServiceAccounts y objetos RBAC durante el laboratorio.
  - Trabajar desde Visual Studio Code utilizando Git Bash como terminal principal.
  - Disponer del directorio local cka-labs y conservar el clúster creado o validado en la práctica anterior.
introduction:
  - En esta práctica implementarás acceso controlado a la API de Kubernetes utilizando RBAC. Crearás una identidad técnica, definirás permisos limitados dentro de un namespace, comprobarás decisiones de autorización, construirás un kubeconfig temporal basado en un token de corta duración y ampliarás de forma explícita un permiso de lectura a nivel de clúster. La práctica termina con dos retos en los que diagnosticarás una asignación RBAC incorrecta y construirás una política de privilegio mínimo sin recibir los comandos de solución.
slug: lab4
lab_number: 4
final_result: >
  Al finalizar habrás configurado una identidad con permisos limitados sobre recursos namespaced, validado sus autorizaciones con kubectl auth can-i, utilizado un kubeconfig temporal autenticado mediante un token de ServiceAccount, concedido una capacidad de lectura específica a nivel de clúster y resuelto dos escenarios de RBAC aplicando diagnóstico y privilegio mínimo sin recurrir a permisos administrativos amplios.
notes:
  - La práctica utiliza un ServiceAccount como identidad técnica para observar RBAC de forma reproducible; en entornos reales, los usuarios humanos suelen autenticarse mediante certificados, OIDC u otro proveedor de identidad.
  - Los tokens creados con kubectl create token son credenciales temporales. No los copies en repositorios ni los reutilices como credenciales permanentes.
  - No se utilizará cluster-admin para resolver los retos. El objetivo es conceder únicamente los permisos necesarios y validar tanto acciones permitidas como denegadas.
  - Los comandos se ejecutan desde Git Bash y cada operación importante se mantiene separada de su validación para facilitar el diagnóstico.
references:
  - text: Autorización RBAC en Kubernetes
    url: https://kubernetes.io/docs/reference/access-authn-authz/rbac/
  - text: kubectl auth can-i
    url: https://kubernetes.io/docs/reference/kubectl/generated/kubectl_auth/kubectl_auth_can-i/
  - text: kubectl create token
    url: https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_token/
prev: /lab3/lab3/
next: /lab5/lab5/
---

---

<!-- Aquí comienzan las instrucciones paso a paso de la práctica -->

## 🔎 Tarea 1. Preparar el escenario y reconocer el alcance de RBAC — 4 min

Prepararás un namespace aislado con una carga sencilla y confirmarás el contexto administrativo actual. Este escenario permitirá distinguir permisos dentro de un namespace de permisos que afectan recursos de todo el clúster.

### Tarea 1.1. Confirmar el contexto y el estado del clúster

Antes de modificar RBAC, verificarás que kubectl apunta al clúster esperado y que los nodos continúan operativos después de la práctica anterior.

- {% include step_label.html %} Muestra el contexto activo de kubectl para identificar qué credencial administrativa utilizarás durante la configuración inicial.

  ```bash
  kubectl config current-context
  ```

  > **Salida esperada:** Se muestra el nombre del contexto configurado para el clúster CKA.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta los nodos y confirma que el control plane y los workers disponibles se encuentran en estado `Ready`.

  ```bash
  kubectl get nodes -o wide
  ```

  > **Salida esperada:** Los nodos esperados aparecen en estado `Ready`; no continúes si algún nodo requerido por el laboratorio permanece `NotReady`.
  {: .lab-note .output .compact}

### Tarea 1.2. Crear el namespace y una carga de referencia

Crearás un namespace exclusivo para la práctica y un Deployment que después será utilizado para comprobar qué operaciones permite o rechaza RBAC.

- {% include step_label.html %} Crea el namespace `lab4` para aislar los recursos y las políticas namespaced de este laboratorio.

  ```bash
  kubectl create namespace lab4
  ```

  > **Salida esperada:** Kubernetes responde `namespace/lab4 created`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Crea el Deployment `web` con dos réplicas de NGINX dentro de `lab4`.

  ```bash
  kubectl create deployment web --image=nginx:1.29-alpine --replicas=2 -n lab4
  ```

  > **Salida esperada:** Kubernetes responde `deployment.apps/web created`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Espera a que las dos réplicas del Deployment estén disponibles antes de comenzar las pruebas de autorización.

  ```bash
  kubectl rollout status deployment/web -n lab4 --timeout=90s
  ```

  > **Salida esperada:** El rollout finaliza correctamente y el Deployment informa que está disponible.
  {: .lab-note .output .compact}

### Tarea 1.3. Observar recursos namespaced y cluster-scoped

Compararás dos alcances distintos porque esa diferencia determina si debes utilizar `Role` o `ClusterRole`.

> **Importante:** Un `Role` siempre pertenece a un namespace. Un `ClusterRole` no está asociado a un namespace y también puede conceder acceso sobre recursos cluster-scoped, como `nodes`.
{: .lab-note .important .compact}

- {% include step_label.html %} Lista los Pods de `lab4` y después consulta los nodos para observar un recurso namespaced y uno de alcance de clúster.

  ```bash
  kubectl get pods -n lab4
  ```

  ```bash
  kubectl get nodes
  ```

  > **Salida esperada:** Los Pods se consultan dentro de `lab4`, mientras que los nodos se muestran sin utilizar un namespace.
  {: .lab-note .output .compact}

{% assign results = site.data.task-results[page.slug].results %}
{% capture r1 %}{{ results[0] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r1 %}

{% include support-prompt.html task="tarea1" %}

---

## 👤 Tarea 2. Crear una identidad técnica para el acceso controlado — 4 min

Crearás un ServiceAccount que actuará como identidad independiente del administrador. Antes de asignarle permisos comprobarás que existir no implica tener autorización sobre los recursos del namespace.

### Tarea 2.1. Crear el ServiceAccount

Un ServiceAccount proporciona una identidad reconocible por la API de Kubernetes. RBAC decidirá posteriormente qué acciones puede realizar esa identidad.

- {% include step_label.html %} Crea el ServiceAccount `lab4-operator` dentro del namespace `lab4`.

  ```bash
  kubectl create serviceaccount lab4-operator -n lab4
  ```

  > **Salida esperada:** Kubernetes responde `serviceaccount/lab4-operator created`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Consulta el ServiceAccount para confirmar su namespace y existencia antes de asociarle permisos.

  ```bash
  kubectl get serviceaccount lab4-operator -n lab4
  ```

  > **Salida esperada:** Se muestra `lab4-operator` dentro del namespace `lab4`.
  {: .lab-note .output .compact}

### Tarea 2.2. Validar que la identidad inicia sin permisos útiles

Utilizarás impersonación para preguntar al API Server qué podría hacer el ServiceAccount sin cambiar todavía tus credenciales locales.

> **Nota:** La identidad completa de un ServiceAccount sigue el formato `system:serviceaccount:<namespace>:<nombre>`. `kubectl auth can-i --as` permite probar decisiones de autorización desde una cuenta con permiso de impersonación.
{: .lab-note .info .compact}

- {% include step_label.html %} Comprueba si `lab4-operator` puede listar Pods dentro de su propio namespace antes de crear una política RBAC.

  ```bash
  kubectl auth can-i list pods -n lab4 --as=system:serviceaccount:lab4:lab4-operator
  ```

  > **Salida esperada:** El resultado es `no`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba también si la misma identidad puede consultar nodos, recurso que no pertenece a ningún namespace.

  ```bash
  kubectl auth can-i list nodes --as=system:serviceaccount:lab4:lab4-operator
  ```

  > **Salida esperada:** El resultado es `no`.
  {: .lab-note .output .compact}

{% capture r2 %}{{ results[1] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r2 %}

{% include support-prompt.html task="tarea2" %}

---

## 🛡️ Tarea 3. Definir permisos de lectura con un Role — 5 min

Crearás una política namespaced que permita consultar Pods y Deployments, pero no modificarlos. El manifiesto hará visible la relación entre API groups, resources y verbs.

### Tarea 3.1. Preparar el manifiesto del Role

Crearás el archivo dentro del workspace para conservar evidencia de la política utilizada durante la práctica.

- {% include step_label.html %} Crea el directorio `workspace/lab4` desde la raíz del repositorio y entra en él.

  ```bash
  mkdir -p workspace/lab4
  ```

  ```bash
  cd workspace/lab4
  ```

  > **Salida esperada:** La terminal queda ubicada en `cka-labs/workspace/lab4`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Crea `role-reader.yaml` con permisos de lectura para Pods y Deployments dentro de `lab4`.

  > **Importante:** Los Pods pertenecen al core API group, representado por `""`; los Deployments pertenecen a `apps`. Los verbos `get`, `list` y `watch` permiten lectura sin conceder creación, modificación o eliminación.
  {: .lab-note .important .compact}

  ```bash
  cat > role-reader.yaml <<'EOF'
  apiVersion: rbac.authorization.k8s.io/v1
  kind: Role
  metadata:
    name: workload-reader
    namespace: lab4
  rules:
    - apiGroups: [""]
      resources: ["pods"]
      verbs: ["get", "list", "watch"]
    - apiGroups: ["apps"]
      resources: ["deployments"]
      verbs: ["get", "list", "watch"]
  EOF
  ```

  > **Salida esperada:** Se crea `workspace/lab4/role-reader.yaml` con dos reglas de lectura.
  {: .lab-note .output .compact}

### Tarea 3.2. Validar y aplicar el Role

Antes de crearlo en el clúster comprobarás que el manifiesto puede ser procesado correctamente por kubectl.

- {% include step_label.html %} Ejecuta una validación client-side del manifiesto sin crear todavía el Role.

  ```bash
  kubectl apply --dry-run=client -f role-reader.yaml
  ```

  > **Salida esperada:** kubectl muestra `role.rbac.authorization.k8s.io/workload-reader created (dry run)`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Aplica el manifiesto para registrar el Role `workload-reader` dentro de `lab4`.

  ```bash
  kubectl apply -f role-reader.yaml
  ```

  > **Salida esperada:** Kubernetes responde `role.rbac.authorization.k8s.io/workload-reader created`.
  {: .lab-note .output .compact}

### Tarea 3.3. Inspeccionar las reglas efectivas del Role

Revisarás el objeto creado para relacionar el YAML con la forma en que Kubernetes almacena las reglas de autorización.

- {% include step_label.html %} Describe el Role y localiza los recursos y verbos concedidos por cada regla.

  ```bash
  kubectl describe role workload-reader -n lab4
  ```

  > **Salida esperada:** Se muestran permisos `get`, `list` y `watch` sobre `pods` y `deployments`, sin verbos de escritura.
  {: .lab-note .output .compact}

- {% include step_label.html %} Confirma que crear Pods no forma parte de las reglas definidas en el Role.

  ```bash
  kubectl auth can-i create pods -n lab4 --as=system:serviceaccount:lab4:lab4-operator
  ```

  > **Salida esperada:** El resultado continúa siendo `no`, porque todavía no existe un binding y además el Role no concede `create`.
  {: .lab-note .output .compact}

{% capture r3 %}{{ results[2] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r3 %}

{% include support-prompt.html task="tarea3" %}

---

## 🔗 Tarea 4. Asociar la identidad mediante RoleBinding — 5 min

Un Role define permisos, pero no identifica quién los recibe. Crearás un RoleBinding para conectar `lab4-operator` con `workload-reader` únicamente dentro del namespace `lab4`.

### Tarea 4.1. Crear el RoleBinding

Generarás el binding mediante kubectl y después inspeccionarás su referencia y su sujeto.

- {% include step_label.html %} Asocia el Role `workload-reader` con el ServiceAccount `lab4-operator` mediante un RoleBinding namespaced.

  ```bash
  kubectl create rolebinding lab4-operator-reader \
    --role=workload-reader \
    --serviceaccount=lab4:lab4-operator \
    -n lab4
  ```

  > **Salida esperada:** Kubernetes responde `rolebinding.rbac.authorization.k8s.io/lab4-operator-reader created`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Describe el RoleBinding para comprobar el `RoleRef` y el ServiceAccount configurado como sujeto.

  ```bash
  kubectl describe rolebinding lab4-operator-reader -n lab4
  ```

  > **Salida esperada:** `RoleRef` apunta a `workload-reader` y el sujeto corresponde a `lab4-operator` del namespace `lab4`.
  {: .lab-note .output .compact}

### Tarea 4.2. Verificar acciones permitidas

Ahora que existe la asociación, las acciones incluidas en el Role deben cambiar de `no` a `yes`.

- {% include step_label.html %} Verifica que el ServiceAccount ya puede listar Pods dentro de `lab4`.

  ```bash
  kubectl auth can-i list pods -n lab4 --as=system:serviceaccount:lab4:lab4-operator
  ```

  > **Salida esperada:** El resultado es `yes`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Verifica que también puede consultar Deployments dentro del mismo namespace.

  ```bash
  kubectl auth can-i get deployments.apps -n lab4 --as=system:serviceaccount:lab4:lab4-operator
  ```

  > **Salida esperada:** El resultado es `yes`.
  {: .lab-note .output .compact}

### Tarea 4.3. Comprobar límites de la política

Validar una política de privilegio mínimo también implica probar explícitamente operaciones que deben continuar denegadas.

> **Importante:** RBAC es aditivo: un binding agrega permisos, pero no crea reglas de denegación. Para demostrar el alcance de esta política debes verificar que ninguna otra asignación esté otorgando privilegios adicionales a la identidad.
{: .lab-note .important .compact}

- {% include step_label.html %} Comprueba que el ServiceAccount no puede eliminar Pods en `lab4`.

  ```bash
  kubectl auth can-i delete pods -n lab4 --as=system:serviceaccount:lab4:lab4-operator
  ```

  > **Salida esperada:** El resultado es `no`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba que tampoco puede listar Pods en el namespace `kube-system`.

  ```bash
  kubectl auth can-i list pods -n kube-system --as=system:serviceaccount:lab4:lab4-operator
  ```

  > **Salida esperada:** El resultado es `no`, demostrando que el RoleBinding solo tiene efecto dentro de `lab4`.
  {: .lab-note .output .compact}

{% capture r4 %}{{ results[3] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r4 %}

{% include support-prompt.html task="tarea4" %}

---

## 🔐 Tarea 5. Construir un kubeconfig temporal para la identidad — 6 min

Hasta ahora probaste permisos mediante impersonación. En esta tarea solicitarás un token temporal para `lab4-operator` y crearás un contexto que realmente se autentique con esa identidad.

### Tarea 5.1. Obtener un token de corta duración

El token será utilizado únicamente durante esta práctica y no se escribirá manualmente dentro de ningún manifiesto.

> **Advertencia:** Un token permite autenticarse contra el API Server con los permisos de su ServiceAccount. No muestres su valor en capturas, documentación ni repositorios.
{: .lab-note .warning .compact}

- {% include step_label.html %} Solicita un token con duración de 30 minutos y guárdalo temporalmente en la variable `LAB4_TOKEN`.

  ```bash
  LAB4_TOKEN=$(kubectl create token lab4-operator -n lab4 --duration=30m)
  ```

  > **Salida esperada:** La variable queda cargada con un token temporal; el comando no necesita imprimirlo en pantalla.
  {: .lab-note .output .compact}

- {% include step_label.html %} Confirma únicamente que la variable contiene datos sin revelar la credencial.

  ```bash
  test -n "$LAB4_TOKEN" && echo "Token temporal cargado"
  ```

  > **Salida esperada:** Se muestra `Token temporal cargado`.
  {: .lab-note .output .compact}

### Tarea 5.2. Crear un kubeconfig aislado

Partirás de la configuración del contexto actual para conservar endpoint y certificado del clúster, pero crearás una nueva credencial y un nuevo contexto.

- {% include step_label.html %} Guarda el nombre del contexto y del clúster actual para reutilizar su configuración de conexión.

  ```bash
  CURRENT_CONTEXT=$(kubectl config current-context)
  ```

  ```bash
  CURRENT_CLUSTER=$(kubectl config view -o jsonpath="{.contexts[?(@.name==\"${CURRENT_CONTEXT}\")].context.cluster}")
  ```

  > **Salida esperada:** `CURRENT_CONTEXT` y `CURRENT_CLUSTER` identifican el contexto administrativo y el clúster al que apunta.
  {: .lab-note .output .compact}

- {% include step_label.html %} Crea un kubeconfig independiente que contenga únicamente la configuración activa de conexión al clúster.

  ```bash
  kubectl config view --raw --minify > lab4-operator.kubeconfig
  ```

  > **Salida esperada:** Se crea `lab4-operator.kubeconfig` dentro de `workspace/lab4`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Agrega al kubeconfig una credencial denominada `lab4-operator` utilizando el token temporal.

  ```bash
  kubectl config set-credentials lab4-operator \
    --token="$LAB4_TOKEN" \
    --kubeconfig=lab4-operator.kubeconfig
  ```

  > **Salida esperada:** kubectl informa que el usuario `lab4-operator` fue configurado.
  {: .lab-note .output .compact}

- {% include step_label.html %} Crea el contexto `lab4-operator` usando esa credencial y establece `lab4` como namespace predeterminado.

  ```bash
  kubectl config set-context lab4-operator \
    --cluster="$CURRENT_CLUSTER" \
    --user=lab4-operator \
    --namespace=lab4 \
    --kubeconfig=lab4-operator.kubeconfig
  ```

  > **Salida esperada:** kubectl informa que el contexto `lab4-operator` fue creado.
  {: .lab-note .output .compact}

### Tarea 5.3. Ejecutar solicitudes con la identidad real

Comprobarás que el comportamiento observado mediante impersonación coincide con el acceso autenticado usando el token.

- {% include step_label.html %} Lista los Pods utilizando exclusivamente el nuevo kubeconfig y el contexto `lab4-operator`.

  ```bash
  kubectl --kubeconfig=lab4-operator.kubeconfig --context=lab4-operator get pods
  ```

  > **Salida esperada:** Se muestran los Pods del Deployment `web`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Intenta consultar nodos utilizando el mismo kubeconfig para comprobar que el acceso cluster-scoped continúa restringido.

  ```bash
  kubectl --kubeconfig=lab4-operator.kubeconfig --context=lab4-operator get nodes
  ```

  > **Salida esperada:** La solicitud es rechazada con `Forbidden`, porque todavía no se ha concedido permiso para leer `nodes`.
  {: .lab-note .output .compact}

{% capture r5 %}{{ results[4] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r5 %}

{% include support-prompt.html task="tarea5" %}

---

## 🌐 Tarea 6. Conceder una capacidad de lectura a nivel de clúster — 5 min

Crearás un ClusterRole muy específico para consultar nodos y lo asociarás con la misma identidad. Compararás este alcance con el Role namespaced creado anteriormente.

### Tarea 6.1. Crear el ClusterRole

El nuevo permiso será deliberadamente estrecho: solo lectura de nodos mediante `get` y `list`.

- {% include step_label.html %} Crea `clusterrole-node-reader.yaml` con una regla de lectura sobre el recurso `nodes`.

  ```bash
  cat > clusterrole-node-reader.yaml <<'EOF'
  apiVersion: rbac.authorization.k8s.io/v1
  kind: ClusterRole
  metadata:
    name: lab4-node-reader
  rules:
    - apiGroups: [""]
      resources: ["nodes"]
      verbs: ["get", "list"]
  EOF
  ```

  > **Salida esperada:** Se crea el manifiesto local del ClusterRole sin incluir permisos de escritura.
  {: .lab-note .output .compact}

- {% include step_label.html %} Aplica el ClusterRole al clúster.

  ```bash
  kubectl apply -f clusterrole-node-reader.yaml
  ```

  > **Salida esperada:** Kubernetes responde `clusterrole.rbac.authorization.k8s.io/lab4-node-reader created`.
  {: .lab-note .output .compact}

### Tarea 6.2. Asociar el ClusterRole con la identidad

Para que el permiso sea efectivo sobre un recurso cluster-scoped utilizarás un ClusterRoleBinding.

> **Nota:** Un `RoleBinding` puede referenciar un `ClusterRole`, pero su efecto sigue limitado al namespace del binding. Para conceder permisos sobre `nodes`, que son cluster-scoped, necesitas un `ClusterRoleBinding`.
{: .lab-note .info .compact}

- {% include step_label.html %} Crea el ClusterRoleBinding que asigna `lab4-node-reader` al ServiceAccount `lab4-operator`.

  ```bash
  kubectl create clusterrolebinding lab4-operator-node-reader \
    --clusterrole=lab4-node-reader \
    --serviceaccount=lab4:lab4-operator
  ```

  > **Salida esperada:** Kubernetes responde `clusterrolebinding.rbac.authorization.k8s.io/lab4-operator-node-reader created`.
  {: .lab-note .output .compact}

### Tarea 6.3. Validar el nuevo alcance

Comprobarás que solo cambió la capacidad cluster-scoped que acabas de conceder.

- {% include step_label.html %} Verifica mediante autorización que la identidad ahora puede listar nodos.

  ```bash
  kubectl auth can-i list nodes --as=system:serviceaccount:lab4:lab4-operator
  ```

  > **Salida esperada:** El resultado es `yes`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Repite la consulta de nodos utilizando el kubeconfig temporal para probar el permiso con autenticación real.

  ```bash
  kubectl --kubeconfig=lab4-operator.kubeconfig --context=lab4-operator get nodes
  ```

  > **Salida esperada:** Se muestran los nodos del clúster sin error `Forbidden`.
  {: .lab-note .output .compact}

{% capture r6 %}{{ results[5] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r6 %}

{% include support-prompt.html task="tarea6" %}

---

## 🧩 Tarea 7. Reto: diagnosticar una asignación RBAC incorrecta — 5 min

En este reto recibirás una política válida conectada a la identidad equivocada. Deberás identificar por qué una operación autorizada por el Role sigue siendo rechazada y corregir únicamente el objeto responsable.

### Tarea 7.1. Preparar el escenario defectuoso

Crearás un segundo ServiceAccount, un Role y un RoleBinding con una inconsistencia intencional. El diagnóstico y la corrección son parte del reto.

- {% include step_label.html %} Crea el ServiceAccount `support-agent`, que será la identidad que debe recibir acceso de lectura a ConfigMaps.

  ```bash
  kubectl create serviceaccount support-agent -n lab4
  ```

  > **Salida esperada:** Kubernetes responde `serviceaccount/support-agent created`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Crea un ConfigMap de referencia para disponer de un recurso que el agente deberá consultar.

  ```bash
  kubectl create configmap app-settings --from-literal=environment=training -n lab4
  ```

  > **Salida esperada:** Kubernetes responde `configmap/app-settings created`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Aplica el siguiente manifiesto.


  ```bash
  cat > broken-rbac.yaml <<'EOF'
  apiVersion: rbac.authorization.k8s.io/v1
  kind: Role
  metadata:
    name: configmap-reader
    namespace: lab4
  rules:
    - apiGroups: [""]
      resources: ["configmaps"]
      verbs: ["get", "list"]
  ---
  apiVersion: rbac.authorization.k8s.io/v1
  kind: RoleBinding
  metadata:
    name: support-configmap-reader
    namespace: lab4
  subjects:
    - kind: ServiceAccount
      name: support-viewer
      namespace: lab4
  roleRef:
    apiGroup: rbac.authorization.k8s.io
    kind: Role
    name: configmap-reader
  EOF
  ```

  ```bash
  kubectl apply -f broken-rbac.yaml
  ```

  > **Salida esperada:** El Role y el RoleBinding se crean correctamente; Kubernetes no considera inválido que el nombre del sujeto no corresponda a la identidad que pretendes autorizar.
  {: .lab-note .output .compact}

### Tarea 7.2. Diagnosticar el fallo

A partir de aquí no recibirás comandos de corrección. Utiliza inspección de RBAC, `kubectl auth can-i` y los comandos de ayuda que consideres necesarios.

- {% include step_label.html %} Comprueba si `support-agent` puede obtener ConfigMaps en `lab4` y confirma que la autorización falla.

  ```bash
  kubectl auth can-i get configmaps -n lab4 --as=system:serviceaccount:lab4:support-agent
  ```

  > **Salida esperada:** El resultado es `no`.
  {: .lab-note .output .compact}

> **Reto:** Identifica qué elemento del escenario impide que `support-agent` reciba el Role `configmap-reader`. Corrige únicamente la asignación necesaria, sin ampliar los verbos del Role y sin utilizar `cluster-admin`.
{: .lab-note .important .compact}

### Tarea 7.3. Validar tu corrección

Las siguientes pruebas indican qué debe cumplirse, pero no proporcionan el comando utilizado para reparar el binding.

- {% include step_label.html %} Ejecuta nuevamente la comprobación de lectura después de aplicar tu corrección.

  ```bash
  kubectl auth can-i get configmaps -n lab4 --as=system:serviceaccount:lab4:support-agent
  ```

  > **Salida esperada:** El resultado ahora es `yes`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Verifica que el agente no recibió permiso para eliminar ConfigMaps.

  ```bash
  kubectl auth can-i delete configmaps -n lab4 --as=system:serviceaccount:lab4:support-agent
  ```

  > **Salida esperada:** El resultado es `no`.
  {: .lab-note .output .compact}

{% capture r7 %}{{ results[6] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r7 %}

{% include support-prompt.html task="tarea7" %}

---

## 🎯 Tarea 8. Reto: construir acceso de privilegio mínimo — 6 min

Crearás desde cero una política para una nueva identidad siguiendo requisitos funcionales. No se proporcionan comandos de implementación; deberás elegir los objetos RBAC, reglas y asociaciones apropiadas.

### Tarea 8.1. Crear la identidad del auditor

La identidad ya se proporciona para que el reto se concentre en diseñar la autorización.

- {% include step_label.html %} Crea el ServiceAccount `audit-reader` dentro del namespace `lab4`.

  ```bash
  kubectl create serviceaccount audit-reader -n lab4
  ```

  > **Salida esperada:** Kubernetes responde `serviceaccount/audit-reader created`.
  {: .lab-note .output .compact}

### Tarea 8.2. Diseñar e implementar la política

Debes construir los objetos necesarios para cumplir exactamente los siguientes requisitos.

> **Reto:** `audit-reader` debe poder ejecutar `get` y `list` sobre `pods` y `deployments` únicamente dentro de `lab4`. No debe crear ni eliminar esos recursos, no debe leer `secrets`, no debe recibir permisos sobre otros namespaces y no debes utilizar `cluster-admin`, `admin`, `edit`, `view` ni un `ClusterRoleBinding`.
{: .lab-note .important .compact}

- {% include step_label.html %} Crea uno o más manifiestos YAML en `workspace/lab4` e implementa la política utilizando objetos RBAC con el alcance mínimo necesario.

  > **Nota:** Puedes consultar `kubectl explain role`, `kubectl explain rolebinding`, `kubectl create role --help` y `kubectl create rolebinding --help`. El reto evalúa la selección y configuración de los objetos, no la memorización literal del YAML.
  {: .lab-note .info .compact}

### Tarea 8.3. Validar la política y limpiar el laboratorio

Utiliza estas pruebas como criterios de aceptación. Si alguna respuesta no coincide, corrige tu política antes de continuar con la limpieza.

- {% include step_label.html %} Comprueba que el auditor puede listar Pods dentro de `lab4`.

  ```bash
  kubectl auth can-i list pods -n lab4 --as=system:serviceaccount:lab4:audit-reader
  ```

  > **Salida esperada:** El resultado es `yes`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba que el auditor puede obtener Deployments dentro de `lab4`.

  ```bash
  kubectl auth can-i get deployments.apps -n lab4 --as=system:serviceaccount:lab4:audit-reader
  ```

  > **Salida esperada:** El resultado es `yes`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba que el auditor no puede eliminar Pods ni consultar Secrets.

  ```bash
  kubectl auth can-i delete pods -n lab4 --as=system:serviceaccount:lab4:audit-reader
  ```

  ```bash
  kubectl auth can-i get secrets -n lab4 --as=system:serviceaccount:lab4:audit-reader
  ```

  > **Salida esperada:** Ambos comandos responden `no`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Comprueba que el auditor tampoco puede listar Pods fuera de `lab4`.

  ```bash
  kubectl auth can-i list pods -n kube-system --as=system:serviceaccount:lab4:audit-reader
  ```

  > **Salida esperada:** El resultado es `no`.
  {: .lab-note .output .compact}

> **Advertencia:** Ejecuta la limpieza solo después de completar y validar los dos retos. Eliminar el namespace retirará la mayoría de los recursos namespaced utilizados como evidencia.
{: .lab-note .warning .compact}

- {% include step_label.html %} Elimina el ClusterRoleBinding y el ClusterRole creados específicamente para el acceso a nodos.

  ```bash
  kubectl delete clusterrolebinding lab4-operator-node-reader
  ```

  ```bash
  kubectl delete clusterrole lab4-node-reader
  ```

  > **Salida esperada:** Kubernetes confirma la eliminación de ambos objetos cluster-scoped.
  {: .lab-note .output .compact}

- {% include step_label.html %} Elimina el namespace `lab4` y conserva los manifiestos locales como evidencia de la práctica.

  ```bash
  kubectl delete namespace lab4 --wait=true
  ```

  > **Salida esperada:** Kubernetes responde `namespace "lab4" deleted`.
  {: .lab-note .output .compact}

- {% include step_label.html %} Elimina de la sesión de Git Bash la variable que contenía el token temporal.

  ```bash
  unset LAB4_TOKEN
  ```

  > **Salida esperada:** La variable deja de existir en la sesión actual; `workspace/lab4` permanece disponible con los manifiestos creados.
  {: .lab-note .output .compact}

{% capture r8 %}{{ results[7] }}{% endcapture %}
{% include task-result.html title="Tarea finalizada" content=r8 %}

{% include support-prompt.html task="tarea8" %}
