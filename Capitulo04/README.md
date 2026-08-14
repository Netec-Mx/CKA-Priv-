# 4 Práctica 4: Configurar acceso administrativo controlado con RBAC

## Metadatos

| Campo | Valor |
|---|---|
| Duración | 40 minutos |
| Complejidad | Media |
| Nivel de Bloom | Aplicar |

## Descripción general

En esta práctica inspeccionará el kubeconfig administrativo generado por `kubeadm`, identificará la relación entre clúster, usuario y contexto, y creará una copia de trabajo protegida. Posteriormente, configurará RBAC para una cuenta de soporte limitada al namespace `operations`, con permiso adicional de solo lectura sobre los nodos del clúster.

Finalmente, generará un kubeconfig temporal basado en un token para la cuenta restringida y comprobará, mediante `kubectl auth can-i`, qué acciones están permitidas y cuáles son denegadas. La práctica distingue explícitamente entre autenticación mediante certificado o token y autorización mediante RBAC.

## Objetivos de aprendizaje

Al finalizar la práctica, podrá:

- [ ] Inspeccionar el contenido lógico de `/etc/kubernetes/admin.conf` sin exponer material sensible.
- [ ] Crear y proteger una copia administrativa de trabajo con permisos `0600`.
- [ ] Crear un `ServiceAccount`, un `Role`, un `RoleBinding`, un `ClusterRole` y un `ClusterRoleBinding`.
- [ ] Generar un kubeconfig temporal basado en token para una identidad restringida.
- [ ] Validar permisos permitidos y denegados mediante `kubectl auth can-i`.

## Prerrequisitos

### Conocimientos requeridos

- Conceptos básicos de namespaces, Pods, Deployments y ServiceAccounts.
- Uso básico de `kubectl`.
- Diferencia conceptual entre autenticación y autorización.
- Lectura básica de manifiestos YAML de Kubernetes.
- Conocimiento de que un contexto de kubeconfig relaciona un clúster, una identidad y un namespace opcional.

### Acceso requerido

- Práctica 3 completada.
- Clúster de cuatro nodos operativo: `cp1`, `worker1`, `worker2` y `worker3`.
- `worker3` en estado `Ready`.
- Namespace `operations` creado en la Práctica 2.
- Al menos un Deployment disponible en `operations`.
- Acceso SSH o consola a `cp1` con privilegios `sudo`.
- Acceso administrativo mediante el contexto `kubernetes-admin@kubernetes`.

> **Advertencia de seguridad:** `/etc/kubernetes/admin.conf` normalmente autentica como `kubernetes-admin`, miembro del grupo `system:masters`. Esta identidad tiene privilegios administrativos amplios. No copie este archivo a ubicaciones compartidas ni lo exponga en terminales, repositorios o sistemas de tickets.

## Entorno de laboratorio

### Topología esperada

| Nodo | Dirección IP | Función |
|---|---:|---|
| `cp1` | `10.10.10.10` | Control plane |
| `worker1` | `10.10.10.11` | Worker |
| `worker2` | `10.10.10.12` | Worker |
| `worker3` | `10.10.10.13` | Worker |

### Componentes relevantes

| Componente | Versión o configuración esperada |
|---|---|
| Kubernetes | `1.31.6-1.1` |
| API Server | `https://10.10.10.10:6443` |
| Runtime | containerd `1.7.24-1` |
| CNI | Calico `3.29.2` |
| Namespace de soporte | `operations` |
| Cuenta restringida | `ops-maintainer` |
| Kubeconfig administrativo de origen | `/etc/kubernetes/admin.conf` |

### Preparación inicial

Conéctese a `cp1` y abra una sesión administrativa controlada:

```bash
ssh <usuario-admin>@10.10.10.10
sudo -i
```

Defina variables para evitar errores de escritura y utilizar explícitamente los kubeconfig correctos durante toda la práctica:

```bash
export ADMIN_KUBECONFIG=/root/labs/kubeconfigs/admin-training.conf
export OPS_KUBECONFIG=/root/labs/kubeconfigs/ops-maintainer-token.conf
export LAB_NAMESPACE=operations
export SERVICE_ACCOUNT=ops-maintainer
```

Compruebe el estado general del clúster usando directamente el kubeconfig administrativo original. Todavía no existe la copia de trabajo:

```bash
kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes -o wide
kubectl --kubeconfig=/etc/kubernetes/admin.conf get namespace operations
kubectl --kubeconfig=/etc/kubernetes/admin.conf -n operations get deployments
```

La salida debe incluir los cuatro nodos y todos deben estar en estado `Ready`.

---

## Procedimiento paso a paso

### Paso 1. Verificar el estado inicial y la identidad administrativa

**Objetivo:** confirmar que el clúster está disponible, que el namespace requerido existe y que la sesión actual dispone de acceso administrativo.

**Instrucciones:**

1. Compruebe la conectividad con el API Server y la información básica del clúster:

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf cluster-info
   ```

2. Liste los nodos y confirme que `worker3` está disponible:

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes
   ```

3. Compruebe los recursos de la Práctica 2 en el namespace `operations`:

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf -n operations get deployments,pods
   ```

4. Consulte la identidad autenticada por el API Server:

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf auth whoami
   ```

5. Verifique que la identidad administrativa puede consultar nodos:

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf auth can-i get nodes
   ```

**Salida esperada:**

- Los cuatro nodos deben mostrarse como `Ready`.
- El namespace `operations` debe existir.
- Debe existir al menos un Deployment en `operations`.
- La identidad autenticada normalmente será similar a:

  ```text
  ATTRIBUTE   VALUE
  Username    kubernetes-admin
  Groups      [system:masters system:authenticated]
  ```

- La autorización para consultar nodos debe responder:

  ```text
  yes
  ```

**Verificación:**

Ejecute el siguiente bloque. No continúe si alguno de los nodos no está disponible o si no existe el namespace `operations`.

```bash
kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes
kubectl --kubeconfig=/etc/kubernetes/admin.conf get ns operations
kubectl --kubeconfig=/etc/kubernetes/admin.conf -n operations get deploy
```

> **Nota operativa:** `system:masters` suele estar asociado al rol administrativo completo mediante un `ClusterRoleBinding`. Esta práctica no modifica esa configuración ni los certificados del control plane.

---

### Paso 2. Inspeccionar el kubeconfig administrativo sin exponer secretos

**Objetivo:** identificar los elementos `cluster`, `user`, `context` y `current-context` del kubeconfig administrativo.

**Instrucciones:**

1. Consulte el contexto activo del kubeconfig administrativo:

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf config current-context
   ```

2. Liste los contextos disponibles:

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf config get-contexts
   ```

3. Obtenga el nombre lógico del clúster asociado al contexto actual:

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf \
     config view --minify \
     -o jsonpath='{.contexts[0].context.cluster}{"\n"}'
   ```

4. Obtenga el usuario configurado en el contexto actual:

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf \
     config view --minify \
     -o jsonpath='{.contexts[0].context.user}{"\n"}'
   ```

5. Consulte el endpoint del API Server definido en la entrada del clúster:

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf \
     config view --minify \
     -o jsonpath='{.clusters[0].cluster.server}{"\n"}'
   ```

6. Verifique que el usuario administrativo utiliza credenciales de certificado de cliente, sin imprimir la clave privada:

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf \
     config view --minify \
     -o jsonpath='{.users[0].user.client-certificate-data}' \
     | base64 -d \
     | openssl x509 -noout -subject -issuer -dates
   ```

**Salida esperada:**

La salida debe mostrar valores equivalentes a los siguientes:

```text
kubernetes-admin@kubernetes
kubernetes
kubernetes-admin
https://10.10.10.10:6443
```

La inspección del certificado debe indicar un sujeto similar a:

```text
subject=O = system:masters, CN = kubernetes-admin
```

**Verificación:**

Confirme la relación conceptual:

| Elemento | Valor esperado |
|---|---|
| Clúster | `kubernetes` |
| Usuario | `kubernetes-admin` |
| Contexto | `kubernetes-admin@kubernetes` |
| Endpoint | `https://10.10.10.10:6443` |
| Mecanismo de autenticación | Certificado X.509 de cliente |
| Autorización efectiva | Privilegios administrativos mediante RBAC |

> **Importante:** no ejecute `kubectl config view --raw` sin filtrar la salida, ya que puede imprimir datos de certificados y claves privadas codificados en Base64. El kubeconfig contiene información sensible.

---

### Paso 3. Crear una copia administrativa de trabajo protegida

**Objetivo:** crear un kubeconfig administrativo de trabajo en una ruta controlada y protegerlo con permisos restrictivos.

**Instrucciones:**

1. Cree el directorio destinado a los kubeconfig de laboratorio:

   ```bash
   install -d -m 0700 /root/labs/kubeconfigs
   ```

2. Copie el kubeconfig administrativo desde la ruta gestionada por `kubeadm`:

   ```bash
   install -m 0600 /etc/kubernetes/admin.conf "$ADMIN_KUBECONFIG"
   ```

3. Confirme el propietario y los permisos del archivo:

   ```bash
   ls -ld /root/labs/kubeconfigs
   ls -l "$ADMIN_KUBECONFIG"
   ```

4. Verifique que la copia permite acceder al clúster:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" config current-context
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" get nodes
   ```

5. Consulte la identidad autenticada usando la copia de trabajo:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" auth whoami
   ```

**Salida esperada:**

El directorio debe tener permisos `0700` y el archivo administrativo permisos `0600`:

```text
drwx------ 2 root root ... /root/labs/kubeconfigs
-rw------- 1 root root ... /root/labs/kubeconfigs/admin-training.conf
```

El contexto debe continuar siendo:

```text
kubernetes-admin@kubernetes
```

**Verificación:**

Ejecute:

```bash
stat -c '%a %U:%G %n' "$ADMIN_KUBECONFIG"
```

La salida esperada es similar a:

```text
600 root:root /root/labs/kubeconfigs/admin-training.conf
```

> **Relación técnica:** el kubeconfig administrativo contiene la URL del API Server, la CA para validar TLS y un certificado de cliente con su clave. El API Server autentica el certificado y, posteriormente, RBAC decide si la identidad autenticada puede ejecutar la acción solicitada.

---

### Paso 4. Crear la cuenta de servicio y el Role limitado a `operations`

**Objetivo:** crear una identidad de soporte y asignarle permisos de consulta y escalado exclusivamente dentro del namespace `operations`.

**Instrucciones:**

1. Cree el `ServiceAccount` `ops-maintainer`:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     -n "$LAB_NAMESPACE" \
     create serviceaccount "$SERVICE_ACCOUNT"
   ```

2. Cree el archivo de manifiesto para el Role:

   ```bash
   cat > /root/labs/ops-maintainer-role.yaml <<'EOF'
   apiVersion: rbac.authorization.k8s.io/v1
   kind: Role
   metadata:
     name: ops-maintainer-role
     namespace: operations
   rules:
     - apiGroups: [""]
       resources:
         - pods
         - events
         - configmaps
       verbs:
         - get
         - list
         - watch
     - apiGroups: ["apps"]
       resources:
         - deployments
         - replicasets
       verbs:
         - get
         - list
         - watch
     - apiGroups: ["apps"]
       resources:
         - deployments/scale
       verbs:
         - get
         - patch
         - update
   EOF
   ```

3. Revise el manifiesto antes de aplicarlo:

   ```bash
   cat /root/labs/ops-maintainer-role.yaml
   ```

4. Aplique el Role:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     apply -f /root/labs/ops-maintainer-role.yaml
   ```

5. Inspeccione el Role creado:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     -n "$LAB_NAMESPACE" \
     describe role ops-maintainer-role
   ```

**Salida esperada:**

Debe crearse el Role:

```text
role.rbac.authorization.k8s.io/ops-maintainer-role created
```

La descripción debe mostrar permisos de lectura sobre:

- `pods`
- `events`
- `configmaps`
- `deployments`
- `replicasets`

También debe mostrar permisos `get`, `patch` y `update` sobre:

```text
deployments/scale.apps
```

**Verificación:**

Compruebe que el Role existe únicamente en el namespace `operations`:

```bash
kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
  -n operations get role ops-maintainer-role
```

> **Concepto clave:** un `Role` contiene reglas RBAC con alcance de namespace. Aunque tenga el mismo nombre en varios namespaces, cada instancia es independiente. Este Role no concede permisos sobre recursos en `default`, `kube-system` u otros namespaces.

---

### Paso 5. Vincular el Role al ServiceAccount mediante un RoleBinding

**Objetivo:** asociar la identidad `ops-maintainer` con los permisos definidos en `ops-maintainer-role`.

**Instrucciones:**

1. Cree el `RoleBinding`:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     -n "$LAB_NAMESPACE" \
     create rolebinding ops-maintainer-binding \
     --role=ops-maintainer-role \
     --serviceaccount=operations:ops-maintainer
   ```

2. Inspeccione el RoleBinding:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     -n "$LAB_NAMESPACE" \
     describe rolebinding ops-maintainer-binding
   ```

3. Consulte el manifiesto efectivo del RoleBinding:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     -n "$LAB_NAMESPACE" \
     get rolebinding ops-maintainer-binding -o yaml
   ```

**Salida esperada:**

La descripción debe asociar:

```text
Role:
  Kind: Role
  Name: ops-maintainer-role
Subjects:
  Kind: ServiceAccount
  Name: ops-maintainer
  Namespace: operations
```

**Verificación:**

Ejecute:

```bash
kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
  -n operations get rolebinding ops-maintainer-binding
```

> **Concepto clave:** un `RoleBinding` concede permisos dentro de su propio namespace. En este caso, enlaza el Role local `ops-maintainer-role` con el ServiceAccount `system:serviceaccount:operations:ops-maintainer`.

---

### Paso 6. Crear el ClusterRole de lectura de nodos y su ClusterRoleBinding

**Objetivo:** conceder a `ops-maintainer` acceso de solo lectura a los nodos, que son recursos de alcance de clúster.

**Instrucciones:**

1. Cree el manifiesto del `ClusterRole`:

   ```bash
   cat > /root/labs/node-readonly-clusterrole.yaml <<'EOF'
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRole
   metadata:
     name: node-readonly
   rules:
     - apiGroups: [""]
       resources:
         - nodes
       verbs:
         - get
         - list
         - watch
   EOF
   ```

2. Aplique el `ClusterRole`:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     apply -f /root/labs/node-readonly-clusterrole.yaml
   ```

3. Cree el `ClusterRoleBinding` para el ServiceAccount:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     create clusterrolebinding ops-maintainer-node-readonly \
     --clusterrole=node-readonly \
     --serviceaccount=operations:ops-maintainer
   ```

4. Inspeccione el ClusterRole:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     describe clusterrole node-readonly
   ```

5. Inspeccione el ClusterRoleBinding:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     describe clusterrolebinding ops-maintainer-node-readonly
   ```

**Salida esperada:**

El ClusterRole debe limitarse a:

```text
Resources   Non-Resource URLs   Resource Names   Verbs
nodes       []                  []               [get list watch]
```

El ClusterRoleBinding debe mostrar como sujeto:

```text
Kind: ServiceAccount
Name: ops-maintainer
Namespace: operations
```

**Verificación:**

Compare los cuatro objetos RBAC utilizados:

| Objeto | Alcance | Función en esta práctica |
|---|---|---|
| `Role` | Namespace | Define permisos sobre recursos de `operations`. |
| `RoleBinding` | Namespace | Asigna el Role a `ops-maintainer` en `operations`. |
| `ClusterRole` | Clúster | Define lectura de recursos globales `nodes`. |
| `ClusterRoleBinding` | Clúster | Asigna lectura global de nodos al ServiceAccount. |

Ejecute:

```bash
kubectl --kubeconfig="$ADMIN_KUBECONFIG" -n operations get role,rolebinding
kubectl --kubeconfig="$ADMIN_KUBECONFIG" get clusterrole node-readonly
kubectl --kubeconfig="$ADMIN_KUBECONFIG" get clusterrolebinding ops-maintainer-node-readonly
```

> **Importante:** un `ClusterRole` puede contener reglas para recursos de clúster o de namespace. Sin embargo, el `ClusterRoleBinding` concede dichas reglas en todo el clúster. Por ese motivo, debe usarse con especial cuidado.

---

### Paso 7. Generar un kubeconfig temporal basado en token

**Objetivo:** crear una configuración de acceso restringida para `ops-maintainer`, usando un token temporal emitido mediante la API TokenRequest.

**Instrucciones:**

1. Obtenga el endpoint del API Server desde el kubeconfig administrativo:

   ```bash
   export API_SERVER=$(
     kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
       config view --minify \
       -o jsonpath='{.clusters[0].cluster.server}'
   )

   echo "$API_SERVER"
   ```

2. Extraiga la CA del clúster desde el kubeconfig administrativo. El archivo local se utilizará únicamente para construir el kubeconfig temporal:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     config view --raw --minify \
     -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' \
     | base64 -d > /root/labs/kubeconfigs/cluster-ca.crt
   ```

3. Proteja el certificado de CA local:

   ```bash
   chmod 0600 /root/labs/kubeconfigs/cluster-ca.crt
   ```

4. Solicite un token temporal de una hora para el ServiceAccount:

   ```bash
   export OPS_TOKEN=$(
     kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
       -n "$LAB_NAMESPACE" \
       create token "$SERVICE_ACCOUNT" \
       --duration=1h
   )
   ```

5. Compruebe que la variable contiene un token, sin imprimirlo completo:

   ```bash
   echo "Longitud del token: ${#OPS_TOKEN}"
   ```

6. Cree un kubeconfig vacío para la identidad restringida:

   ```bash
   rm -f "$OPS_KUBECONFIG"
   touch "$OPS_KUBECONFIG"
   chmod 0600 "$OPS_KUBECONFIG"
   ```

7. Configure la entrada del clúster e incruste la CA:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     config set-cluster kubernetes \
     --server="$API_SERVER" \
     --certificate-authority=/root/labs/kubeconfigs/cluster-ca.crt \
     --embed-certs=true
   ```

8. Configure la identidad basada en token:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     config set-credentials ops-maintainer \
     --token="$OPS_TOKEN"
   ```

9. Cree el contexto restringido con namespace predeterminado `operations`:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     config set-context ops-maintainer@kubernetes \
     --cluster=kubernetes \
     --user=ops-maintainer \
     --namespace="$LAB_NAMESPACE"
   ```

10. Seleccione el contexto creado:

    ```bash
    kubectl --kubeconfig="$OPS_KUBECONFIG" \
      config use-context ops-maintainer@kubernetes
    ```

11. Elimine la variable de shell que contiene el token:

    ```bash
    unset OPS_TOKEN
    ```

12. Inspeccione la estructura lógica del kubeconfig restringido:

    ```bash
    kubectl --kubeconfig="$OPS_KUBECONFIG" config get-contexts
    kubectl --kubeconfig="$OPS_KUBECONFIG" config current-context
    kubectl --kubeconfig="$OPS_KUBECONFIG" config view --minify
    ```

**Salida esperada:**

El contexto activo debe ser:

```text
ops-maintainer@kubernetes
```

El kubeconfig debe incluir:

- Un clúster denominado `kubernetes`.
- El servidor `https://10.10.10.10:6443`.
- Un usuario denominado `ops-maintainer`.
- Un contexto con namespace predeterminado `operations`.

**Verificación:**

Compruebe la identidad autenticada por el API Server:

```bash
kubectl --kubeconfig="$OPS_KUBECONFIG" auth whoami
```

La salida debe indicar una identidad equivalente a:

```text
Username    system:serviceaccount:operations:ops-maintainer
Groups      [system:serviceaccounts system:serviceaccounts:operations system:authenticated]
```

> **Concepto clave:** el kubeconfig restringido autentica usando un token de portador. El token identifica al ServiceAccount, pero no contiene por sí mismo las reglas RBAC descritas en esta práctica. El API Server consulta las asignaciones RBAC para decidir si cada solicitud está permitida.

---

### Paso 8. Validar operaciones permitidas con la identidad restringida

**Objetivo:** demostrar que `ops-maintainer` puede consultar recursos en `operations`, leer nodos y escalar Deployments en el namespace autorizado.

**Instrucciones:**

1. Compruebe los permisos de consulta sobre Pods:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i get pods -n operations

   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i list pods -n operations
   ```

2. Compruebe los permisos de consulta sobre Deployments, ReplicaSets, Events y ConfigMaps:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i get deployments -n operations

   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i list replicasets -n operations

   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i list events -n operations

   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i get configmaps -n operations
   ```

3. Compruebe el permiso de escalado sobre el subrecurso `deployments/scale`:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i patch deployments/scale -n operations
   ```

4. Compruebe el permiso de lectura de nodos de alcance global:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i get nodes

   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i list nodes
   ```

5. Realice consultas reales usando el kubeconfig restringido:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" get pods
   kubectl --kubeconfig="$OPS_KUBECONFIG" get deployments
   kubectl --kubeconfig="$OPS_KUBECONFIG" get events --sort-by=.lastTimestamp
   kubectl --kubeconfig="$OPS_KUBECONFIG" get nodes
   ```

6. Identifique un Deployment disponible en `operations`:

   ```bash
   export DEPLOYMENT=$(
     kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
       -n "$LAB_NAMESPACE" \
       get deployments \
       -o jsonpath='{.items[0].metadata.name}'
   )

   echo "$DEPLOYMENT"
   ```

7. Obtenga el número actual de réplicas y guárdelo para restaurarlo al finalizar:

   ```bash
   export ORIGINAL_REPLICAS=$(
     kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
       -n "$LAB_NAMESPACE" \
       get deployment "$DEPLOYMENT" \
       -o jsonpath='{.spec.replicas}'
   )

   echo "$ORIGINAL_REPLICAS"
   ```

8. Escale temporalmente el Deployment usando exclusivamente el kubeconfig restringido:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     -n "$LAB_NAMESPACE" \
     scale deployment "$DEPLOYMENT" --replicas=2
   ```

9. Confirme el cambio mediante la identidad restringida:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     -n "$LAB_NAMESPACE" \
     get deployment "$DEPLOYMENT"
   ```

10. Restaure el número de réplicas original usando la misma identidad restringida:

    ```bash
    kubectl --kubeconfig="$OPS_KUBECONFIG" \
      -n "$LAB_NAMESPACE" \
      scale deployment "$DEPLOYMENT" --replicas="$ORIGINAL_REPLICAS"
    ```

**Salida esperada:**

Los comandos `kubectl auth can-i` de este paso deben responder:

```text
yes
```

La consulta de nodos debe funcionar, aunque el ServiceAccount pertenezca al namespace `operations`, porque el `ClusterRoleBinding` otorga lectura global sobre `nodes`.

El escalado del Deployment debe mostrar una salida similar a:

```text
deployment.apps/<nombre-deployment> scaled
```

**Verificación:**

Confirme que el Deployment recuperó el número original de réplicas:

```bash
kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
  -n "$LAB_NAMESPACE" \
  get deployment "$DEPLOYMENT" \
  -o jsonpath='{.spec.replicas}{"\n"}'
```

El valor debe coincidir con el contenido de `ORIGINAL_REPLICAS`.

---

### Paso 9. Validar operaciones expresamente denegadas

**Objetivo:** demostrar el principio de mínimo privilegio y confirmar que la cuenta no puede ejecutar operaciones administrativas fuera de su alcance.

**Instrucciones:**

1. Compruebe que la cuenta no puede eliminar nodos:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i delete nodes
   ```

2. Compruebe que no puede leer Secrets en `operations`:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i get secrets -n operations
   ```

3. Compruebe que no puede crear recursos en el namespace `default`:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i create configmaps -n default
   ```

4. Compruebe que no puede consultar Pods en `default`:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i list pods -n default
   ```

5. Compruebe que no puede crear Deployments en `operations`, ya que solo dispone de permiso para leerlos y escalar el subrecurso:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i create deployments -n operations
   ```

6. Pruebe una solicitud real de lectura de Secrets. El comando debe fallar y no modifica ningún recurso:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     -n operations \
     get secrets
   ```

**Salida esperada:**

Todos los comandos `kubectl auth can-i` de este paso deben responder:

```text
no
```

La consulta real de Secrets debe producir un error similar a:

```text
Error from server (Forbidden): secrets is forbidden: User "system:serviceaccount:operations:ops-maintainer" cannot list resource "secrets" in API group "" in the namespace "operations"
```

**Verificación:**

Registre la matriz de permisos resultante:

| Acción | Alcance | Resultado esperado |
|---|---|---|
| `get pods` | `operations` | `yes` |
| `list deployments` | `operations` | `yes` |
| `patch deployments/scale` | `operations` | `yes` |
| `list nodes` | Clúster | `yes` |
| `delete nodes` | Clúster | `no` |
| `get secrets` | `operations` | `no` |
| `create configmaps` | `default` | `no` |
| `list pods` | `default` | `no` |
| `create deployments` | `operations` | `no` |

> **Interpretación:** poder leer nodos no convierte a `ops-maintainer` en administrador del clúster. Los permisos se evalúan por verbo, recurso, subrecurso y alcance. El permiso `patch` sobre `deployments/scale` no concede permiso `patch` sobre el recurso `deployments` completo.

---

## Validación y pruebas

Ejecute el siguiente bloque para realizar una validación consolidada. Las primeras cinco comprobaciones deben devolver `yes`; las últimas cuatro, `no`.

```bash
echo "== Identidad restringida =="
kubectl --kubeconfig="$OPS_KUBECONFIG" auth whoami

echo
echo "== Acciones permitidas =="
kubectl --kubeconfig="$OPS_KUBECONFIG" auth can-i get pods -n operations
kubectl --kubeconfig="$OPS_KUBECONFIG" auth can-i list deployments -n operations
kubectl --kubeconfig="$OPS_KUBECONFIG" auth can-i list events -n operations
kubectl --kubeconfig="$OPS_KUBECONFIG" auth can-i patch deployments/scale -n operations
kubectl --kubeconfig="$OPS_KUBECONFIG" auth can-i list nodes

echo
echo "== Acciones denegadas =="
kubectl --kubeconfig="$OPS_KUBECONFIG" auth can-i delete nodes
kubectl --kubeconfig="$OPS_KUBECONFIG" auth can-i get secrets -n operations
kubectl --kubeconfig="$OPS_KUBECONFIG" auth can-i create configmaps -n default
kubectl --kubeconfig="$OPS_KUBECONFIG" auth can-i create deployments -n operations
```

Realice además las siguientes comprobaciones administrativas desde el kubeconfig de trabajo:

```bash
kubectl --kubeconfig="$ADMIN_KUBECONFIG" -n operations get serviceaccount ops-maintainer
kubectl --kubeconfig="$ADMIN_KUBECONFIG" -n operations get role ops-maintainer-role
kubectl --kubeconfig="$ADMIN_KUBECONFIG" -n operations get rolebinding ops-maintainer-binding
kubectl --kubeconfig="$ADMIN_KUBECONFIG" get clusterrole node-readonly
kubectl --kubeconfig="$ADMIN_KUBECONFIG" get clusterrolebinding ops-maintainer-node-readonly
```

Criterios de finalización:

- Existe `/root/labs/kubeconfigs/admin-training.conf` con permisos `0600`.
- El contexto administrativo apunta al clúster correcto.
- El ServiceAccount `ops-maintainer` existe en `operations`.
- El Role permite únicamente consulta de recursos seleccionados y escalado de Deployments.
- El RoleBinding asocia el Role con el ServiceAccount.
- El ClusterRole permite solo `get`, `list` y `watch` sobre `nodes`.
- El ClusterRoleBinding vincula dicho permiso de nodos al ServiceAccount.
- El kubeconfig temporal autentica como `system:serviceaccount:operations:ops-maintainer`.
- La identidad restringida puede operar en `operations` y leer nodos.
- La identidad restringida no puede eliminar nodos, leer Secrets ni crear recursos en `default`.

## Resolución de problemas

### Problema 1: el kubeconfig temporal devuelve `Unauthorized`

**Síntomas**

Al ejecutar un comando con el kubeconfig restringido aparece un error similar a:

```text
error: You must be logged in to the server (Unauthorized)
```

O bien:

```text
Unable to connect to the server: the server has asked for the client to provide credentials
```

**Causa**

El token temporal pudo haber expirado, no se copió correctamente al kubeconfig, se utilizó un endpoint incorrecto o el kubeconfig no contiene la CA válida del clúster.

**Corrección**

1. Confirme el endpoint configurado:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     config view --minify \
     -o jsonpath='{.clusters[0].cluster.server}{"\n"}'
   ```

   Debe mostrar:

   ```text
   https://10.10.10.10:6443
   ```

2. Genere un token nuevo de una hora:

   ```bash
   export OPS_TOKEN=$(
     kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
       -n operations \
       create token ops-maintainer \
       --duration=1h
   )
   ```

3. Actualice las credenciales del kubeconfig temporal:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     config set-credentials ops-maintainer \
     --token="$OPS_TOKEN"
   ```

4. Elimine el token de la variable de shell:

   ```bash
   unset OPS_TOKEN
   ```

5. Valide de nuevo la autenticación:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" auth whoami
   ```

---

### Problema 2: `ops-maintainer` recibe `Forbidden` al escalar un Deployment

**Síntomas**

La comprobación de permisos o el escalado falla:

```text
no
```

o:

```text
Error from server (Forbidden): deployments.apps "<nombre>" is forbidden
```

**Causa**

El Role no incluye permisos sobre el subrecurso `deployments/scale`, el RoleBinding no apunta al Role correcto, o el escalado se intenta fuera del namespace `operations`.

**Corrección**

1. Revise las reglas efectivas del Role:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     -n operations \
     describe role ops-maintainer-role
   ```

2. Confirme que existe una regla para:

   ```text
   Resources: deployments/scale
   Verbs: get, patch, update
   ```

3. Revise el RoleBinding:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     -n operations \
     describe rolebinding ops-maintainer-binding
   ```

4. Reaplique el manifiesto correcto del Role:

   ```bash
   kubectl --kubeconfig="$ADMIN_KUBECONFIG" \
     apply -f /root/labs/ops-maintainer-role.yaml
   ```

5. Asegúrese de usar el namespace explícito al escalar:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     -n operations \
     scale deployment <nombre-deployment> --replicas=2
   ```

6. Compruebe el permiso específico:

   ```bash
   kubectl --kubeconfig="$OPS_KUBECONFIG" \
     auth can-i patch deployments/scale -n operations
   ```

## Limpieza

Esta práctica conserva deliberadamente los objetos RBAC y el ServiceAccount, ya que el acceso delegado `ops-maintainer` se utilizará como referencia de acceso restringido antes de las operaciones administrativas de recuperación de etcd de la Práctica 5.

El token creado mediante `kubectl create token --duration=1h` expira automáticamente. Como medida de higiene operativa, elimine el kubeconfig temporal basado en token y la copia local de la CA si no se utilizarán en la siguiente sesión:

```bash
rm -f /root/labs/kubeconfigs/ops-maintainer-token.conf
rm -f /root/labs/kubeconfigs/cluster-ca.crt
```

Conserve el kubeconfig administrativo de trabajo protegido:

```bash
ls -l /root/labs/kubeconfigs/admin-training.conf
```

La salida debe mantener permisos `0600`:

```text
-rw------- 1 root root ... /root/labs/kubeconfigs/admin-training.conf
```

No elimine los siguientes recursos, salvo que el instructor indique lo contrario:

```text
serviceaccount/ops-maintainer
role/ops-maintainer-role
rolebinding/ops-maintainer-binding
clusterrole/node-readonly
clusterrolebinding/ops-maintainer-node-readonly
```

## Resumen

En esta práctica se separaron dos elementos fundamentales de la seguridad de Kubernetes:

- **Autenticación:** el kubeconfig administrativo utiliza un certificado X.509 de cliente; el kubeconfig restringido utiliza un token temporal de ServiceAccount.
- **Autorización:** RBAC determina qué solicitudes puede realizar cada identidad autenticada.

Se creó una identidad de soporte llamada `ops-maintainer` con privilegios limitados:

- Consulta de Pods, Deployments, ReplicaSets, Events y ConfigMaps en `operations`.
- Escalado de Deployments mediante el subrecurso `deployments/scale`.
- Lectura de nodos mediante un `ClusterRole` y un `ClusterRoleBinding`.
- Sin capacidad para eliminar nodos, leer Secrets, crear Deployments o crear recursos en `default`.

La verificación con `kubectl auth can-i` permite validar permisos antes de ejecutar operaciones reales y constituye una práctica operativa recomendada para administración segura de clústeres Kubernetes.

### Recursos opcionales

- [Autorización RBAC de Kubernetes](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Configuración de acceso a múltiples clústeres](https://kubernetes.io/docs/tasks/access-application-cluster/configure-access-multiple-clusters/)
- [ServiceAccounts de Kubernetes](https://kubernetes.io/docs/concepts/security/service-accounts/)
- [Comando kubectl auth can-i](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_auth/kubectl_auth_can-i/)
