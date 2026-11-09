#!/usr/bin/env python3
"""Lab 1: evaluación de estado en cka-control, sin SSH ni modificaciones."""
import argparse
import datetime as dt
import json
import socket
import subprocess
from pathlib import Path

TASKS = [(1, 15, 'Acceso y contexto'), (2, 25, 'Nodos y capacidad'),
         (3, 25, 'Componentes del control plane'), (5, 15, 'Red, DNS, storage y salud')]
CHECKS = []


def run(*args, timeout=15):
    try:
        p = subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=False)
        return p.returncode == 0, p.stdout.strip(), p.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, '', str(exc)


def record(task, name, ok, detail='', unavailable=False):
    CHECKS.append({'task': task, 'name': name,
                   'status': 'PASS' if ok else ('UNVERIFIED' if unavailable else 'FAIL'),
                   'detail': str(detail)[:400]})


def access_error(err):
    e = err.lower()
    return any(s in e for s in ('permission denied', 'authentication is required',
                                'a password is required', 'not in the sudoers',
                                'sudo: a terminal is required', 'sudo: sorry',
                                'forbidden', 'unauthorized', 'command not found',
                                'no such file or directory'))


def verify_command(task, name, command, predicate=lambda s: bool(s), privileged=False):
    ok, out, err = run(*command, timeout=20)
    if not ok and privileged and command[0] == 'sudo':
        # Si no se requiere privilegio para leer, probar acceso directo.
        ok_direct, out_direct, err_direct = run(*command[2:], timeout=20)
        if ok_direct:
            ok, out, err = ok_direct, out_direct, err_direct
    passed = ok and predicate(out)
    record(task, name, passed, (out or 'Correcto') if passed else (err or out or 'No cumple'),
           unavailable=not ok and access_error(err))


def kube_json(*arguments):
    ok, out, err = run('kubectl', *arguments, '-o', 'json', timeout=20)
    if not ok:
        return None, err or out, access_error(err)
    try:
        return json.loads(out), '', False
    except ValueError:
        return None, 'Respuesta JSON inválida', False


def ready(pod):
    st = pod.get('status', {})
    containers = st.get('containerStatuses') or []
    return st.get('phase') == 'Running' and bool(containers) and all(c.get('ready') for c in containers)


def grade(output):
    summary = []
    for tid, weight, title in TASKS:
        subset = [c for c in CHECKS if c['task'] == tid]
        passed = sum(c['status'] == 'PASS' for c in subset)
        blocked = sum(c['status'] == 'UNVERIFIED' for c in subset)
        points = weight * passed / len(subset) if subset else 0
        summary.append({'task': tid, 'label': title, 'weight': weight,
                        'passed': passed, 'unverified': blocked, 'total': len(subset),
                        'points': round(points, 2)})
    score = round(sum(row['weight'] * row['passed'] / row['total'] for row in summary), 2)
    unverified = sum(c['status'] == 'UNVERIFIED' for c in CHECKS)
    report = {'lab': 'lab1', 'node': 'cka-control', 'type': 'estado_observable_no_ejecucion',
              'timestamp': dt.datetime.now(dt.timezone.utc).isoformat(),
              'score': score, 'max_score': 80, 'percentage': round(score / 80 * 100, 2),
              'provisional': unverified > 0, 'unverified': unverified,
              'summary': summary, 'checks': CHECKS,
              'note': 'La evaluación observa el estado, no demuestra qué comandos ejecutó el alumno. Las verificaciones UNVERIFIED no prueban incumplimiento.'}
    Path(output).write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('\nLAB 1 — EVALUACIÓN LOCAL DE CKA-CONTROL (sin SSH)')
    for row in summary:
        print(f"Tarea {row['task']}: {row['points']:.2f}/{row['weight']} puntos | "
              f"PASS {row['passed']}/{row['total']} | UNVERIFIED {row['unverified']}")
    print(f"RESULTADO CONTROL: {score:.2f}/80 puntos = {report['percentage']:.2f}%" +
          (' (PROVISIONAL: faltan permisos/evidencias)' if unverified else ''))
    print('Reporte:', output)
    for c in CHECKS:
        if c['status'] != 'PASS':
            print(f"  [{c['status']}] T{c['task']} {c['name']}: {c['detail']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output', default='reporte_lab1_control.json')
    args = ap.parse_args()

    verify_command(1, 'Hostname de control', ('hostname',), lambda x: x == 'cka-control')
    verify_command(1, 'IP privada de control', ('ip', '-br', 'addr'), lambda x: '10.10.10.10' in x)
    verify_command(1, 'Contexto activo', ('kubectl', 'config', 'current-context'),
                   lambda x: x == 'kubernetes-admin@kubernetes')
    verify_command(1, 'Contextos disponibles', ('kubectl', 'config', 'get-contexts'),
                   lambda x: 'kubernetes-admin@kubernetes' in x and '*' in x)
    verify_command(1, 'Acceso a cluster-info', ('kubectl', 'cluster-info'),
                   lambda x: 'control plane' in x.lower())
    for label, cmd in [('kubectl', ('kubectl', 'version', '--client')),
                       ('kubeadm', ('kubeadm', 'version', '-o', 'short')),
                       ('kubelet', ('kubelet', '--version'))]:
        verify_command(1, f'Versión {label} 1.35.x', cmd, lambda x: 'v1.35.' in x)

    nodes, error, blocked = kube_json('get', 'nodes')
    if nodes is None:
        record(2, 'Inventario de nodos', False, error, blocked)
    else:
        byname = {n.get('metadata', {}).get('name'): n for n in nodes.get('items', [])}
        record(2, 'Solo control y worker1 unidos', set(byname) == {'cka-control', 'cka-worker1'},
               ', '.join(sorted(byname)))
        for name, ip in [('cka-control', '10.10.10.10'), ('cka-worker1', '10.10.10.11')]:
            n = byname.get(name, {})
            conditions = {c.get('type'): c.get('status') for c in n.get('status', {}).get('conditions', [])}
            record(2, f'{name} Ready', conditions.get('Ready') == 'True', conditions)
            record(2, f'{name} InternalIP', any(a.get('type') == 'InternalIP' and a.get('address') == ip
                   for a in n.get('status', {}).get('addresses', [])), ip)
            runtime = n.get('status', {}).get('nodeInfo', {}).get('containerRuntimeVersion', '')
            record(2, f'{name} usa containerd', 'containerd' in runtime, runtime)
        worker = byname.get('cka-worker1', {})
        w_conditions = {c.get('type'): c.get('status') for c in worker.get('status', {}).get('conditions', [])}
        record(2, 'Worker sin presión de recursos', all(w_conditions.get(k) == 'False'
               for k in ('MemoryPressure', 'DiskPressure', 'PIDPressure')), w_conditions)
        for key in ('capacity', 'allocatable'):
            values = worker.get('status', {}).get(key, {})
            record(2, f'Worker {key} disponible', all(values.get(k) for k in ('cpu', 'memory', 'pods')), values)
        control = byname.get('cka-control', {})
        record(2, 'Label de control-plane', 'node-role.kubernetes.io/control-plane'
               in control.get('metadata', {}).get('labels', {}))
        taints = control.get('spec', {}).get('taints', [])
        record(2, 'Taint NoSchedule en control', any(t.get('key') == 'node-role.kubernetes.io/control-plane'
               and t.get('effect') == 'NoSchedule' for t in taints), taints)
        record(2, 'Worker sin taint control-plane', not any(t.get('key') == 'node-role.kubernetes.io/control-plane'
               for t in worker.get('spec', {}).get('taints', [])))

    pods, error, blocked = kube_json('get', 'pods', '-n', 'kube-system')
    pod_list = pods.get('items', []) if pods else []
    for component in ('kube-apiserver', 'kube-controller-manager', 'kube-scheduler', 'etcd'):
        expected = f'{component}-cka-control'
        found = [p for p in pod_list if p.get('metadata', {}).get('name') == expected]
        record(3, f'{component} Ready en control', bool(found) and all(ready(p) and
               p.get('spec', {}).get('nodeName') == 'cka-control' for p in found),
               error if pods is None else expected, pods is None and blocked)

    for name in ('etcd.yaml', 'kube-apiserver.yaml', 'kube-controller-manager.yaml', 'kube-scheduler.yaml'):
        verify_command(3, f'Manifiesto {name}', ('sudo', '-n', 'test', '-f', f'/etc/kubernetes/manifests/{name}'),
                       lambda _: True, privileged=True)
    verify_command(3, 'Imagen kube-apiserver en manifiesto',
                   ('sudo', '-n', 'grep', 'image:', '/etc/kubernetes/manifests/kube-apiserver.yaml'),
                   lambda x: 'kube-apiserver' in x, privileged=True)
    verify_command(3, 'etcd --data-dir en manifiesto',
                   ('sudo', '-n', 'grep', '--', '--data-dir', '/etc/kubernetes/manifests/etcd.yaml'),
                   lambda x: '--data-dir' in x, privileged=True)
    for comp in ('kube-apiserver', 'etcd'):
        verify_command(3, f'CRI {comp} activo', ('sudo', '-n', 'crictl', 'ps', '--name', comp),
                       lambda x, comp=comp: comp in x, privileged=True)
    verify_command(3, 'API Server /readyz', ('kubectl', 'get', '--raw=/readyz'), lambda x: x == 'ok')
    verify_command(3, 'API Server /readyz?verbose', ('kubectl', 'get', '--raw=/readyz?verbose'),
                   lambda x: 'readyz check passed' in x.lower())

    ds, ds_error, ds_blocked = kube_json('get', 'daemonsets', '-n', 'kube-system')
    daemonsets = {x.get('metadata', {}).get('name'): x for x in ds.get('items', [])} if ds else {}
    for name in ('calico-node', 'kube-proxy'):
        status = daemonsets.get(name, {}).get('status', {})
        desired = status.get('desiredNumberScheduled', 0)
        record(5, f'DaemonSet {name} listo', desired == 2 and status.get('numberReady', 0) == desired and
               status.get('numberAvailable', 0) == desired,
               status or ds_error, ds is None and ds_blocked)
        matched = [p for p in pod_list if p.get('metadata', {}).get('labels', {}).get('k8s-app') == name]
        locations = {p.get('spec', {}).get('nodeName') for p in matched if ready(p)}
        record(5, f'Pods {name} Ready en ambos nodos',
               {'cka-control', 'cka-worker1'} <= locations,
               sorted(locations) if pods else error, pods is None and blocked)
    deployment, error, blocked = kube_json('get', 'deployment', 'coredns', '-n', 'kube-system')
    spec = deployment.get('spec', {}) if deployment else {}
    status = deployment.get('status', {}) if deployment else {}
    replicas = spec.get('replicas', 1)
    record(5, 'CoreDNS disponible', bool(deployment) and replicas > 0 and
           status.get('readyReplicas', 0) == replicas and status.get('availableReplicas', 0) == replicas,
           status or error, deployment is None and blocked)
    service, error, blocked = kube_json('get', 'service', 'kube-dns', '-n', 'kube-system')
    cluster_ip = service.get('spec', {}).get('clusterIP') if service else None
    record(5, 'Service kube-dns (10.96.0.10)', cluster_ip == '10.96.0.10', cluster_ip or error,
           service is None and blocked)
    classes, error, blocked = kube_json('get', 'storageclass')
    items = classes.get('items', []) if classes else []
    record(5, 'local-path predeterminada', any(x.get('metadata', {}).get('name') == 'local-path'
           and x.get('metadata', {}).get('annotations', {}).get('storageclass.kubernetes.io/is-default-class')
           == 'true' for x in items), error or [x.get('metadata', {}).get('name') for x in items],
           classes is None and blocked)
    for resource in ('pv', 'pvc'):
        obj, error, blocked = kube_json('get', resource, *(['-A'] if resource == 'pvc' else []))
        record(5, f'Consulta {resource.upper()} accesible', obj is not None,
               'Consulta completada (puede estar vacía)' if obj is not None else error,
               obj is None and blocked)
    verify_command(5, 'Readiness final', ('kubectl', 'get', '--raw=/readyz'), lambda x: x == 'ok')
    grade(args.output)


if __name__ == '__main__':
    main()
