# Solución — Práctica 4: Configurar acceso administrativo controlado con RBAC

## Tarea 7. Reto: diagnosticar una asignación RBAC incorrecta

### 1. Revisar el RoleBinding defectuoso

```bash
kubectl describe rolebinding support-configmap-reader -n lab4
```

### 2. Confirmar que el sujeto configurado no coincide con el ServiceAccount correcto

El RoleBinding apunta a:

```text
support-viewer
```

pero la identidad correcta es:

```text
support-agent
```

### 3. Eliminar el RoleBinding incorrecto

```bash
kubectl delete rolebinding support-configmap-reader -n lab4
```

### 4. Crear el RoleBinding correcto

```bash
kubectl create rolebinding support-configmap-reader \
  --role=configmap-reader \
  --serviceaccount=lab4:support-agent \
  -n lab4
```

### 5. Validar permiso de lectura

```bash
kubectl auth can-i get configmaps \
  -n lab4 \
  --as=system:serviceaccount:lab4:support-agent
```

Resultado esperado:

```text
yes
```

### 6. Validar que no puede eliminar ConfigMaps

```bash
kubectl auth can-i delete configmaps \
  -n lab4 \
  --as=system:serviceaccount:lab4:support-agent
```

Resultado esperado:

```text
no
```

---

## Tarea 8. Reto: construir acceso de privilegio mínimo

### 1. Crear el Role

```bash
cat > audit-reader-role.yaml <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: audit-reader
  namespace: lab4
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list"]
EOF
```

### 2. Aplicar el Role

```bash
kubectl apply -f audit-reader-role.yaml
```

### 3. Crear el RoleBinding

```bash
kubectl create rolebinding audit-reader-binding \
  --role=audit-reader \
  --serviceaccount=lab4:audit-reader \
  -n lab4
```

### 4. Validar lectura de Pods

```bash
kubectl auth can-i list pods \
  -n lab4 \
  --as=system:serviceaccount:lab4:audit-reader
```

Resultado esperado:

```text
yes
```

### 5. Validar lectura de Deployments

```bash
kubectl auth can-i get deployments.apps \
  -n lab4 \
  --as=system:serviceaccount:lab4:audit-reader
```

Resultado esperado:

```text
yes
```

### 6. Validar que no puede eliminar Pods

```bash
kubectl auth can-i delete pods \
  -n lab4 \
  --as=system:serviceaccount:lab4:audit-reader
```

Resultado esperado:

```text
no
```

### 7. Validar que no puede consultar Secrets

```bash
kubectl auth can-i get secrets \
  -n lab4 \
  --as=system:serviceaccount:lab4:audit-reader
```

Resultado esperado:

```text
no
```

### 8. Validar que no puede listar Pods en otro namespace

```bash
kubectl auth can-i list pods \
  -n kube-system \
  --as=system:serviceaccount:lab4:audit-reader
```

Resultado esperado:

```text
no
```
