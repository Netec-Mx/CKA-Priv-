#!/usr/bin/env python3
"""Evaluador local CKA-Priv Lab 3: ejecutar en cka-control y cka-worker2.

Solo lee el estado. El monitor conserva evidencias transitorias y evita
calificar como fallidas las acciones cuyo estado ya desaparecio.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

VERSION = "1.0.0"
ROOT = Path(__file__).resolve().parent
HOST = socket.gethostname().split('.')[0]
ROLE = {'cka-control': 'control', 'cka-worker2': 'worker2'}.get(HOST)
SPECS = {
    'control': [
        ('c1_nodes_pre', 1, 2, 'Dos nodos Ready antes del join'),
        ('c1_worker_absent', 1, 5, 'Worker2 ausente antes del join'),
        ('c2_new_token', 2, 6, 'Nuevo token bootstrap detectado'),
        ('c2_api', 2, 3, 'API Server accesible'),
        ('c3_registered', 3, 6, 'Worker2 registrado en Kubernetes'),
        ('c3_ready', 3, 5, 'Worker2 Ready'),
        ('c3_ip', 3, 3, 'Worker2 con IP interna 10.10.10.12'),
        ('c4_calico', 4, 5, 'Calico Running/Ready en worker2'),
        ('c4_proxy', 4, 5, 'kube-proxy Running/Ready en worker2'),
        ('c5_pod_ready', 5, 5, 'Pod de prueba Ready en worker2'),
        ('c5_pod_ip', 5, 3, 'Pod de prueba tiene IP de red'),
        ('c5_dns', 5, 4, 'DNS interno resuelto desde Pod'),
        ('c5_coredns', 5, 2, 'CoreDNS disponible'),
        ('c5_cleanup', 5, 3, 'Pod de prueba eliminado despues de validarlo'),
        ('c5_final', 5, 3, 'Tres nodos Ready y schedulable al cierre'),
    ],
    'worker2': [
        ('w1_swap', 1, 2, 'Swap deshabilitado antes del join'),
        ('w1_sysctl', 1, 2, 'Forwarding y bridge netfilter habilitados'),
        ('w1_containerd', 1, 2, 'containerd activo antes del join'),
        ('w1_preconf', 1, 2, 'kubelet.conf ausente antes del join'),
        ('w2_ping', 2, 2, 'Conectividad a control plane'),
        ('w2_tcp', 2, 4, 'Puerto TCP 6443 accesible'),
        ('w3_kconf', 3, 4, 'kubelet.conf creado tras join'),
        ('w3_config', 3, 4, 'config.yaml de kubelet creado'),
        ('w3_flags', 3, 4, 'kubeadm-flags.env configurado'),
        ('w3_kubelet', 3, 4, 'kubelet activo tras join'),
        ('w4_cri_calico', 4, 5, 'CRI ejecuta contenedor Calico'),
        ('w4_cri_proxy', 4, 5, 'CRI ejecuta contenedor kube-proxy'),
    ]
}
MAX_TASKS = {1: 15, 2: 15, 3: 30, 4: 20, 5: 20}
assert sum(x[2] for r in SPECS.values() for x in r) == 100


def run(*args, timeout=7):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return p.returncode == 0, p.stdout.strip(), p.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, '', str(exc)


def kjson(*args):
    ok, out, err = run('kubectl', *args, '-o', 'json')
    if not ok:
        return None, err or out or 'kubectl no disponible'
    try:
        return json.loads(out), ''
    except ValueError as exc:
        return None, str(exc)


def condition_ready(obj):
    return any(c.get('type') == 'Ready' and c.get('status') == 'True'
               for c in obj.get('status', {}).get('conditions', []))


def pods_running_on(items, label, node):
    return any(p.get('spec', {}).get('nodeName') == node and
               p.get('status', {}).get('phase') == 'Running' and
               all(c.get('ready') for c in p.get('status', {}).get('containerStatuses', [])) and
               p.get('status', {}).get('containerStatuses')
               for p in items if label in p.get('metadata', {}).get('name', ''))


def check(role, previous):
    """Regresa mapa id -> (estado, detalle). Solo PASS se acredita."""
    result = {}
    def put(name, passed, detail='', available=True):
        result[name] = ('PASS' if passed else ('PENDIENTE' if available else 'NO_VERIFICABLE'), detail)

    if role == 'control':
        nodes, ne = kjson('get', 'nodes')
        byname = {n['metadata']['name']: n for n in nodes.get('items', [])} if nodes else {}
        worker = byname.get('cka-worker2', {})
        before = ('cka-worker2' not in byname and
                  all(condition_ready(byname.get(n, {})) for n in ('cka-control', 'cka-worker1')))
        put('c1_nodes_pre', before, 'Se requieren dos nodos Ready antes del join', bool(nodes))
        put('c1_worker_absent', bool(nodes) and 'cka-worker2' not in byname,
            'Solo es comprobable antes del join', bool(nodes))
        secrets, se = kjson('get', 'secrets', '-n', 'kube-system')
        tokens = sorted(s.get('metadata', {}).get('name', '') for s in secrets.get('items', [])
                        if s.get('type') == 'bootstrap.kubernetes.io/token') if secrets else None
        baseline = previous.get('baseline_tokens')
        if baseline is None and tokens is not None:
            previous['baseline_tokens'] = tokens
            baseline = tokens
        appeared = bool(tokens is not None and baseline is not None and (set(tokens) - set(baseline)))
        put('c2_new_token', appeared, 'Se compara con tokens existentes al iniciar el monitor', tokens is not None)
        ok, out, err = run('kubectl', 'get', '--raw=/readyz')
        put('c2_api', ok and out.strip() == 'ok' and ('c2_new_token' in previous.get('passed', {}) or appeared),
            'API Server /readyz, despues de generar token nuevo', ok or bool(out))
        put('c3_registered', bool(worker), 'Node cka-worker2 existe', bool(nodes))
        put('c3_ready', bool(worker) and condition_ready(worker), 'Ready=True', bool(nodes))
        addresses = worker.get('status', {}).get('addresses', [])
        put('c3_ip', any(x.get('type') == 'InternalIP' and x.get('address') == '10.10.10.12' for x in addresses),
            'IP 10.10.10.12', bool(nodes))
        sys_pods, pe = kjson('get', 'pods', '-n', 'kube-system')
        pitems = sys_pods.get('items', []) if sys_pods else []
        put('c4_calico', pods_running_on(pitems, 'calico-node-', 'cka-worker2'), 'Pod Calico Ready', bool(sys_pods))
        put('c4_proxy', pods_running_on(pitems, 'kube-proxy-', 'cka-worker2'), 'Pod kube-proxy Ready', bool(sys_pods))
        testpod, tp_err = kjson('get', 'pod', 'worker2-test', '-n', 'default')
        is_pod = bool(testpod)
        pod_ready = is_pod and testpod.get('spec', {}).get('nodeName') == 'cka-worker2' and condition_ready(testpod)
        put('c5_pod_ready', pod_ready, 'Pod worker2-test Ready en cka-worker2', True)
        put('c5_pod_ip', pod_ready and bool(testpod.get('status', {}).get('podIP')), 'Pod IP asignada', True)
        if is_pod and pod_ready:
            ok, stdout, stderr = run('kubectl', 'exec', '-n', 'default', 'worker2-test', '--',
                                     'nslookup', 'kubernetes.default.svc.cluster.local', timeout=9)
            put('c5_dns', ok and ('10.96.0.1' in stdout or 'Name:' in stdout),
                'nslookup ejecutado en el Pod', True)
        else:
            put('c5_dns', False, 'Pod de prueba no disponible para nslookup')
        dep, de = kjson('get', 'deployment', 'coredns', '-n', 'kube-system')
        put('c5_coredns', bool(dep) and ('c5_pod_ready' in previous.get('passed', {}) or pod_ready) and
            dep.get('status', {}).get('availableReplicas', 0) >= 1 and
            dep.get('status', {}).get('availableReplicas', 0) >= dep.get('spec', {}).get('replicas', 1),
            'Deployment CoreDNS disponible', bool(dep))
        prior_pod = 'c5_pod_ready' in previous.get('passed', {})
        prior_dns = 'c5_dns' in previous.get('passed', {})
        put('c5_cleanup', prior_pod and prior_dns and not is_pod,
            'Solo se acredita si ya se observó el Pod y su DNS antes de eliminarlo')
        allready = len(byname) == 3 and all(condition_ready(byname.get(n, {})) and
            not byname.get(n, {}).get('spec', {}).get('unschedulable', False)
            for n in ('cka-control', 'cka-worker1', 'cka-worker2'))
        # Solo acredita estado de cierre si previamente se comprobó eliminación del Pod.
        put('c5_final', allready and ('c5_cleanup' in previous.get('passed', {})),
            'Tres nodos Ready después de limpieza', bool(nodes))
    else:
        ok, swap, err = run('swapon', '--noheadings', '--show')
        prejoin = not Path('/etc/kubernetes/kubelet.conf').exists()
        put('w1_swap', ok and not swap, 'Swap sin dispositivos activos', ok)
        ok1, ipf, _ = run('sysctl', '-n', 'net.ipv4.ip_forward')
        ok2, bridge, _ = run('sysctl', '-n', 'net.bridge.bridge-nf-call-iptables')
        put('w1_sysctl', ok1 and ok2 and ipf == '1' and bridge == '1', 'Ambos sysctl deben ser 1', ok1 and ok2)
        ok, active, _ = run('systemctl', 'is-active', 'containerd')
        put('w1_containerd', ok and active == 'active' and prejoin,
            'Estado previo al join: containerd activo', True)
        put('w1_preconf', prejoin, 'Solo comprobable antes del join')
        ok, _, _ = run('ping', '-c', '1', '-W', '2', '10.10.10.10', timeout=4)
        put('w2_ping', ok, 'Ping al control plane')
        ok, _, err = run('bash', '-c', 'timeout 3 bash -c "</dev/tcp/10.10.10.10/6443"', timeout=5)
        put('w2_tcp', ok, 'Puerto 6443 accesible')
        put('w3_kconf', Path('/etc/kubernetes/kubelet.conf').is_file(), 'Kubeconfig generado')
        put('w3_config', Path('/var/lib/kubelet/config.yaml').is_file(), 'Archivo kubelet config')
        flags = Path('/var/lib/kubelet/kubeadm-flags.env')
        try:
            flagsok = flags.is_file() and 'KUBELET_KUBEADM_ARGS' in flags.read_text()
            put('w3_flags', flagsok, 'Variables kubeadm presentes')
        except PermissionError:
            put('w3_flags', False, 'Sin permiso para leer flags', False)
        ok, out, _ = run('systemctl', 'is-active', 'kubelet')
        put('w3_kubelet', ok and out == 'active' and not prejoin, 'kubelet activo después de join')
        ok, out, err = run('crictl', 'ps', '--output', 'json')
        if ok:
            try:
                containers = json.loads(out).get('containers', [])
            except json.JSONDecodeError:
                containers = []
            names = [c.get('metadata', {}).get('name', '') for c in containers]
            put('w4_cri_calico', 'calico-node' in names, 'Contenedor Calico Running')
            put('w4_cri_proxy', 'kube-proxy' in names, 'Contenedor kube-proxy Running')
        else:
            put('w4_cri_calico', False, 'crictl sin acceso: ' + err[:120], False)
            put('w4_cri_proxy', False, 'crictl sin acceso: ' + err[:120], False)
    return result


def report_path(role):
    return ROOT / ('reporte_lab3_' + role + '.json')


def load(role):
    path = report_path(role)
    if path.is_file():
        data = json.loads(path.read_text(encoding='utf-8'))
        if data.get('role') != role:
            raise ValueError('El reporte existente pertenece a otro nodo')
        return data
    return {'version': VERSION, 'role': role, 'host': HOST, 'created': stamp(),
            'baseline_tokens': None, 'passed': {}, 'last': {}, 'runs': 0}


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def save(role, data):
    path = report_path(role)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    os.replace(temp, path)


@contextlib.contextmanager
def lock():
    path = ROOT / '.evaluar_lab3.lock'
    with open(path, 'a+') as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def scan(role):
    with lock():
        data = load(role)
        statuses = check(role, data)
        data['runs'] += 1
        data['last_scan'] = stamp()
        added = []
        for cid, (state, detail) in statuses.items():
            data['last'][cid] = {'status': state, 'detail': detail}
            if state == 'PASS' and cid not in data['passed']:
                data['passed'][cid] = {'at': stamp(), 'detail': detail}
                added.append(cid)
        # final check may become eligible immediately after detecting cleanup within same scan.
        if role == 'control' and 'c5_cleanup' in added:
            statuses = check(role, data)
            cid = 'c5_final'
            if statuses[cid][0] == 'PASS' and cid not in data['passed']:
                data['passed'][cid] = {'at': stamp(), 'detail': statuses[cid][1]}
                added.append(cid)
        save(role, data)
        return data, added


def summarize(data, title=None, only_task=None):
    role = data['role']
    scores = {}
    print('\n' + (title or ('LAB 3 — EVALUADOR ' + role.upper())))
    for task in range(1, 6):
        specs = [s for s in SPECS[role] if s[1] == task]
        if not specs or (only_task and task != only_task):
            continue
        earned = sum(s[2] for s in specs if s[0] in data.get('passed', {}))
        maximum = sum(s[2] for s in specs)
        state = 'COMPLETADA' if earned == maximum else ('NO INICIADA / SIN EVIDENCIA' if earned == 0 else 'INCOMPLETA / EN PROGRESO')
        scores[task] = earned
        print(f'  Tarea {task}: {state:<28} {earned:>2}/{maximum} puntos')
        for cid, _, points, label in specs:
            if cid in data.get('passed', {}):
                continue
            reason = data.get('last', {}).get(cid, {})
            print(f'    [PENDIENTE] {label} ({points} pts) — {reason.get("detail", "sin captura")[:105]}')
    earned = sum(s[2] for s in SPECS[role] if s[0] in data.get('passed', {}))
    maximum = sum(s[2] for s in SPECS[role])
    if not only_task:
        print(f'  TOTAL {role}: {earned}/{maximum} puntos (sobre 100 combinados)')
        print(f'  Estado: {"COMPLETADO" if earned == maximum else "PROVISIONAL — FALTAN EVIDENCIAS"}')
        print(f'  Reporte: {report_path(role)}')
        print('  Nota: las etapas no capturadas antes de cambiar el entorno no se infieren.')
    return earned


def run_monitor(role):
    pidpath = ROOT / ('.evaluar_lab3_' + role + '.pid')
    pidpath.write_text(str(os.getpid()))
    def cleanup(signum, frame):
        with contextlib.suppress(FileNotFoundError):
            pidpath.unlink()
        sys.exit(0)
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)
    try:
        while True:
            try:
                _, added = scan(role)
                if added:
                    print(stamp(), 'PASS:', ', '.join(added), flush=True)
            except Exception as exc:
                print(stamp(), 'ERROR:', str(exc), flush=True)
            time.sleep(5)
    finally:
        with contextlib.suppress(FileNotFoundError):
            pidpath.unlink()


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def existing_pid(role):
    path = ROOT / ('.evaluar_lab3_' + role + '.pid')
    try:
        pid = int(path.read_text())
        return pid if alive(pid) else None
    except (OSError, ValueError):
        return None


def main():
    parser = argparse.ArgumentParser(description='Evaluador Lab 3 por nodo, monitor y evidencias')
    group = parser.add_mutually_exclusive_group(required=True)
    for flag in ('iniciar', 'estado', 'completo', 'resumen', 'detener', 'autoprueba'):
        group.add_argument('--' + flag, action='store_true')
    group.add_argument('--tarea', type=int, choices=range(1, 6))
    group.add_argument('--consolidar', metavar='REPORTE_WORKER_JSON')
    group.add_argument('--monitor-interno', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.autoprueba:
        assert sum(s[2] for r in SPECS.values() for s in r) == 100
        assert {r: sum(s[2] for s in SPEC) for r, SPEC in SPECS.items()} == {'control': 60, 'worker2': 40}
        for n, expected in MAX_TASKS.items():
            assert sum(s[2] for r in SPECS.values() for s in r if s[1] == n) == expected
        print(f'AUTOPRUEBA OK — v{VERSION}, 5 tareas, control 60 + worker2 40 = 100 puntos')
        return 0
    if ROLE is None:
        print(f'ERROR: host {HOST!r} no admitido. Use cka-control o cka-worker2.', file=sys.stderr)
        return 2
    if args.monitor_interno:
        run_monitor(ROLE)
        return 0
    if args.consolidar:
        if ROLE != 'control':
            parser.error('--consolidar se ejecuta en cka-control')
        own = load('control')
        other = json.loads(Path(args.consolidar).read_text(encoding='utf-8'))
        if other.get('role') != 'worker2':
            parser.error('El archivo no contiene un reporte de worker2')
        a = summarize(own, 'REPORTE CONTROL')
        b = summarize(other, 'REPORTE WORKER2')
        print(f'\nCALIFICACIÓN COMBINADA: {a + b}/100 = {a + b}%')
        print('RESULTADO:', 'COMPLETADO' if a+b == 100 else 'PROVISIONAL / EVIDENCIA PENDIENTE')
        return 0
    if args.iniciar:
        pid = existing_pid(ROLE)
        if pid:
            print(f'Monitor ya está activo (PID {pid}).')
            return 0
        # Captura inmediata de linea base, antes de que comience la practica.
        data, added = scan(ROLE)
        logfile = ROOT / ('evaluar_lab3_' + ROLE + '.log')
        with logfile.open('a') as log:
            proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--monitor-interno'],
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                    cwd=ROOT, start_new_session=True)
        time.sleep(.4)
        print(f'Monitor iniciado en {HOST} (PID {proc.pid}). Captura cada ~5 segundos.')
        print('Reporte:', report_path(ROLE))
        print('Importante: mantener monitor activo antes de ejecutar kubeadm join y antes de borrar Pod de prueba.')
        return 0
    if args.estado:
        pid = existing_pid(ROLE)
        print('Monitor ACTIVO, PID ' + str(pid) if pid else 'Monitor DETENIDO')
        data = load(ROLE)
        print('Última lectura:', data.get('last_scan', 'ninguna'))
        return 0
    if args.detener:
        pid = existing_pid(ROLE)
        if pid:
            os.kill(pid, signal.SIGTERM)
            print('Se solicitó detener monitor. Evidencias preservadas.')
        else:
            print('Monitor ya estaba detenido. Evidencias preservadas.')
        return 0
    if args.completo or args.tarea:
        data, added = scan(ROLE)
        print('Nuevas verificaciones acreditadas:', ', '.join(added) if added else 'ninguna')
        summarize(data, only_task=args.tarea)
        return 0
    if args.resumen:
        summarize(load(ROLE))
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
