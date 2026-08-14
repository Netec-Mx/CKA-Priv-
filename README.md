# Administración, despliegue y preparación para CKA

Este curso complementa el aprendizaje adquirido en CKAD y se enfoca en los contenidos específicos de administración de Kubernetes. El participante trabajará con arquitectura del clúster, componentes del control plane, administración de nodos, scheduling administrativo, kubeadm, kubeconfig, certificados, RBAC, etcd, networking interno, almacenamiento de plataforma y troubleshooting de infraestructura.

El curso evita repetir, en lo posible, temas de desarrollo de aplicaciones ya cubiertos en CKAD. Los recursos como Pods, Deployments, Services o Ingress se utilizan principalmente como objetos de validación y diagnóstico, no como temas centrales de construcción de aplicaciones.

## Estructura

- `CapituloXX/README.md`: guía de laboratorio por capítulo.

## Lista de laboratorios

### Capítulo 1

- [5 Práctica 1: Inspección completa de un clúster Kubernetes](Capitulo01/README.md#5-práctica-1-inspección-completa-de-un-clúster-kubernetes)
  - Descripción: Realizar una inspección completa de un clúster Kubernetes, relacionando la arquitectura del control plane, los componentes del nodo y la lectura operativa del estado del clúster.
  - Duración estimada: 50 min

### Capítulo 2

- [4 Práctica 2: Mantenimiento de nodos y reprogramación de cargas](Capitulo02/README.md#4-práctica-2-mantenimiento-de-nodos-y-reprogramación-de-cargas)
  - Descripción: Realizar mantenimiento de nodos y reprogramación de cargas aplicando estado, roles, labels, allocatable resources, cordon, drain, uncordon y scheduling administrativo.
  - Duración estimada: 60 min

### Capítulo 3

- [5 Práctica 3: Crear o validar un clúster con kubeadm y preparar nodos](Capitulo03/README.md#5-práctica-3-crear-o-validar-un-clúster-con-kubeadm-y-preparar-nodos)
  - Descripción: Crear o validar un clúster con kubeadm y preparar nodos, considerando la inicialización, la unión de nodos y la validación posterior a la instalación o actualización.
  - Duración estimada: 60 min

### Capítulo 4

- [4 Práctica 4: Configurar acceso administrativo controlado con RBAC](Capitulo04/README.md#4-práctica-4-configurar-acceso-administrativo-controlado-con-rbac)
  - Descripción: Configurar acceso administrativo controlado con RBAC, utilizando kubeconfig, contextos, certificados y los objetos Roles, ClusterRoles, RoleBindings y ClusterRoleBindings.
  - Duración estimada: 40 min

### Capítulo 5

- [4 Práctica 5: Backup y restore de etcd](Capitulo05/README.md#4-práctica-5-backup-y-restore-de-etcd)
  - Descripción: Realizar backup y restore de etcd mediante snapshots, considerando su rol dentro del clúster, los riesgos operativos y la validación posterior a restore.
  - Duración estimada: 60 min

### Capítulo 6

- [4 Práctica 6: Diagnóstico de CNI, kube-proxy y CoreDNS](Capitulo06/README.md#4-práctica-6-diagnóstico-de-cni-kube-proxy-y-coredns)
  - Descripción: Diagnosticar CNI, kube-proxy y CoreDNS considerando el modelo de red del clúster, Services, la resolución de endpoints y la resolución interna.
  - Duración estimada: 55 min

### Capítulo 7

- [4 Práctica 7: Diagnóstico de almacenamiento persistente y StorageClass](Capitulo07/README.md#4-práctica-7-diagnóstico-de-almacenamiento-persistente-y-storageclass)
  - Descripción: Diagnosticar almacenamiento persistente y StorageClass considerando aprovisionamiento dinámico, CSI, reclaim policy, errores comunes de montaje, volúmenes, claims y eventos asociados a storage.
  - Duración estimada: 50 min

### Capítulo 8

- [3 Práctica 8: Escenarios integrales de troubleshooting administrativo](Capitulo08/README.md#3-práctica-8-escenarios-integrales-de-troubleshooting-administrativo)
  - Descripción: Resolver escenarios integrales de troubleshooting administrativo aplicando una metodología rápida de diagnóstico CKA sobre fallas de nodo NotReady, CoreDNS, kubelet, scheduling y storage.
  - Duración estimada: 75 min

## Flujo de colaboración

- Trabajar en `changes_course`.
- Crear Pull Request hacia `main`.
- Merge por `Squash and merge`.
