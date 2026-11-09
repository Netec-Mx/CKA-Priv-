#!/usr/bin/env python3
"""CKA-Priv Lab 8 — evaluación observacional de incidentes v1.0.0.

Mismo script en cka-control y cka-worker2. No modifica Kubernetes ni servicios.
Conservar el monitor desde el inicio y capturar las fallas antes de corregirlas.
No muestra causas técnicas de los retos en los mensajes de evaluación.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager

VERSION = '1.0.0'
ROOT = Path(__file__).resolve().parent
INTERVAL = 12
TASK_NAMES = {
    1: 'Línea base del clúster',
    2: 'Recuperación de cka-worker2',
    3: 'Recuperación de scheduling',
    4: 'Recuperación de Service',
    5: 'Recuperación de almacenamiento',
    6: 'Recuperación del control plane',
    7: 'Validación integral y limpieza',
}
# ID, tarea, puntos, texto seguro (sin exponer causas), prerrequisitos de evidencia
CONTROL = [
    ('c_nodes_base',1,4,'Nodos Ready antes de incidentes',()),
    ('c_system_base',1,4,'Componentes esenciales saludables al inicio',()),
    ('c_api_base',1,2,'API Server disponible inicialmente',()),
    ('c_node_bad',2,4,'Incidente de disponibilidad del nodo observado',('c_nodes_base',)),
    ('c_node_good',2,6,'Nodo recuperado y estable',('c_node_bad',)),
    ('c_sched_bad',3,5,'Workload no programable observado',()),
    ('c_sched_fix',3,5,'Restricción de scheduling corregida',('c_sched_bad',)),
    ('c_sched_ready',3,5,'Dos réplicas disponibles',('c_sched_bad','c_sched_fix')),
    ('c_svc_bad',4,5,'Service sin backends observado',()),
    ('c_svc_backends',4,5,'Backends restaurados',('c_svc_bad',)),
    ('c_svc_http',4,5,'Conectividad HTTP por Service verificada',('c_svc_bad','c_svc_backends')),
    ('c_pvc_bad',5,5,'Incompatibilidad de almacenamiento observada',()),
    ('c_pvc_bound',5,5,'PVC ligado al volumen esperado',('c_pvc_bad',)),
    ('c_pvc_data',5,5,'Pod recuperado con contenido persistente',('c_pvc_bad','c_pvc_bound')),
    ('c_cp_bad',6,6,'Incidente de control plane observado',()),
    ('c_cp_fixed',6,6,'Componente de control plane reparado',('c_cp_bad',)),
    ('c_cp_pod',6,4,'Pod de prueba programado y listo',('c_cp_bad','c_cp_fixed')),
    ('c_cp_system',6,4,'Componente de sistema estable',('c_cp_bad','c_cp_fixed')),
    ('c_cleanup',7,5,'Limpieza y clúster saludable al cierre',
     ('c_node_good','c_sched_ready','c_svc_http','c_pvc_data','c_cp_pod')),
]
WORKER = [
    ('w_failure',2,4,'Incidente local del worker observado',()),
    ('w_recovery',2,6,'Servicio local recuperado',('w_failure',)),
]
assert sum(x[2] for x in CONTROL) == 90
assert sum(x[2] for x in WORKER) == 10
assert len({x[0] for x in CONTROL + WORKER}) == len(CONTROL + WORKER)


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def host():
    return socket.gethostname().split('.')[0].lower()


def determine_mode(requested):
    if requested != 'auto':
        return requested
    if host() == 'cka-control':
        return 'control'
    if host() == 'cka-worker2':
        return 'worker2'
    raise SystemExit('Host no reconocido. Usa --modo control o --modo worker2 cuando corresponda.')


def paths(mode):
    suffix = 'control' if mode == 'control' else 'worker2'
    return (ROOT / f'reporte_lab8_{suffix}.json',
            ROOT / f'.evaluar_lab8_{suffix}.lock',
            ROOT / f'.evaluar_lab8_{suffix}.pid',
            ROOT / f'.evaluar_lab8_{suffix}.log')


@contextmanager
def report_lock(p):
    with p.open('a+', encoding='utf-8') as file:
        fcntl.flock(file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(file.fileno(), fcntl.LOCK_UN)


def blank(mode):
    return {'version': VERSION, 'lab': 8, 'modo': mode, 'host': host(),
            'created_at': timestamp(), 'updated_at': timestamp(),
            'checks_run': 0, 'evidence': {}, 'last_observations': {}}


def read_report(p, mode):
    if not p.exists():
        return blank(mode)
    d = json.loads(p.read_text(encoding='utf-8'))
    if (d.get('lab') != 8 or d.get('modo') != mode or
            d.get('host') != host() or not isinstance(d.get('evidence'), dict)):
        raise RuntimeError(f'Reporte de otro nodo o incompatible: {p}. No se sobrescribe.')
    return d


def write_report(p, d):
    d['updated_at'] = timestamp()
    fd, temp = tempfile.mkstemp(prefix='.lab8-', dir=ROOT)
    try:
        os.fchmod(fd, 0o600)
        # Reporte generado bajo sudo: lectura permitida al usuario SSH original.
        if os.geteuid() == 0 and os.environ.get('SUDO_UID'):
            try:
                os.fchown(fd, int(os.environ['SUDO_UID']), int(os.environ.get('SUDO_GID', -1)))
            except (OSError, ValueError):
                pass
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(d, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, p)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def run(argv, timeout=8):
    try:
        proc = subprocess.run(argv, capture_output=True, text=True,
                              timeout=timeout, check=False, errors='replace')
        return proc.returncode, proc.stdout, proc.stderr
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, '', f'{type(exc).__name__}: {str(exc)[:120]}'


class Probe:
    def __init__(self, mode):
        self.mode = mode
        self.cache = {}

    def call(self, argv, timeout=8):
        key = (tuple(argv), timeout)
        if key not in self.cache:
            self.cache[key] = run(argv, timeout)
        return self.cache[key]

    def get(self, kind, name=None, ns=None, labels=None):
        args = ['kubectl', '--request-timeout=5s', 'get', kind]
        if name:
            args.append(name)
        if ns:
            args += ['-n', ns]
        if labels:
            args += ['-l', labels]
        args += ['-o', 'json']
        rc, out, err = self.call(args, 9)
        if rc == 0:
            try:
                return json.loads(out), None
            except (ValueError, TypeError):
                return None, 'UNVERIFIED: kubectl no devolvió JSON válido'
        if 'NotFound' in err or 'not found' in err:
            return None, 'NOT_FOUND'
        return None, 'UNVERIFIED: API no disponible o consulta fallida'

    def raw_ready(self):
        rc, out, _ = self.call(['kubectl', '--request-timeout=5s', 'get', '--raw=/readyz'], 9)
        return rc == 0 and out.strip() == 'ok'

    def exec_pod(self, ns, pod, cmd, timeout=9):
        return self.call(['kubectl', '--request-timeout=5s', 'exec', '-n', ns, pod, '--'] + cmd, timeout)


def field(obj, *parts, default=None):
    value = obj
    for part in parts:
        if not isinstance(value, dict):
            return default
        value = value.get(part)
    return default if value is None else value


def ready_node(obj):
    return any(c.get('type') == 'Ready' and c.get('status') == 'True'
               for c in field(obj,'status','conditions',default=[]))


def ready_pod(obj):
    return field(obj,'status','phase') == 'Running' and any(
        c.get('type') == 'Ready' and c.get('status') == 'True'
        for c in field(obj,'status','conditions',default=[]))


def items(obj):
    return obj.get('items', []) if isinstance(obj,dict) else []


def endpoints_ready(obj):
    return sum(1 for sl in items(obj) for ep in sl.get('endpoints', [])
               if ep.get('addresses') and ep.get('conditions', {}).get('ready') is not False)


def deployment_ok(d, wanted=2):
    return (field(d,'spec','replicas') == wanted and
            field(d,'status','availableReplicas',default=0) >= wanted and
            field(d,'status','readyReplicas',default=0) >= wanted)


def status(result):
    # true=PASS; false=FAIL; None=UNVERIFIED
    return 'PASS' if result is True else ('FAIL' if result is False else 'UNVERIFIED')


def check_control(p):
    results = {}
    nodes, ne = p.get('nodes')
    # Checks depend on the actual three training hosts, not just any node count.
    node_list = {field(x,'metadata','name'): x for x in items(nodes)}
    if ne:
        results['c_nodes_base'] = None
    else:
        results['c_nodes_base'] = all(ready_node(node_list[n]) for n in
                                     ('cka-control','cka-worker1','cka-worker2') if n in node_list) and all(
                                     n in node_list for n in ('cka-control','cka-worker1','cka-worker2'))
    pods, pe = p.get('pods', ns='kube-system')
    if pe:
        results['c_system_base'] = None
    else:
        group = items(pods)
        essentials = ['kube-apiserver','kube-controller-manager','kube-scheduler','etcd','coredns','kube-proxy']
        results['c_system_base'] = all(any(field(x,'metadata','name',default='').startswith(prefix)
                                           and ready_pod(x) for x in group) for prefix in essentials)
    results['c_api_base'] = True if p.raw_ready() else None
    if ne:
        results['c_node_bad'] = results['c_node_good'] = None
    else:
        node = node_list.get('cka-worker2')
        results['c_node_bad'] = False if node is None else not ready_node(node)
        results['c_node_good'] = ready_node(node) if node else False

    dep, de = p.get('deployment','reports',ns='exam-scheduling')
    if de and de != 'NOT_FOUND':
        results['c_sched_bad'] = results['c_sched_fix'] = results['c_sched_ready'] = None
    else:
        configured = field(dep,'spec','template','spec','nodeSelector',default={}) if dep else {}
        if dep:
            # Bad only if deployment is genuinely blocked by selector and replicas unavailable.
            selector = configured.get('kubernetes.io/hostname','')
            results['c_sched_bad'] = bool(selector and selector not in node_list and
                                          field(dep,'status','availableReplicas',default=0) < 2)
            results['c_sched_fix'] = not selector or selector in node_list
            results['c_sched_ready'] = deployment_ok(dep)
        else:
            results['c_sched_bad'] = results['c_sched_fix'] = results['c_sched_ready'] = False

    svc, se = p.get('service','payments-svc',ns='exam-network')
    pay_dep, pde = p.get('deployment','payments',ns='exam-network')
    slices, sle = p.get('endpointslices',ns='exam-network',labels='kubernetes.io/service-name=payments-svc')
    if any(e and e != 'NOT_FOUND' for e in (se,pde,sle)):
        for k in ('c_svc_bad','c_svc_backends','c_svc_http'):
            results[k] = None
    elif svc and pay_dep:
        count = endpoints_ready(slices)
        healthy = deployment_ok(pay_dep)
        selector = field(svc,'spec','selector',default={})
        results['c_svc_bad'] = healthy and count == 0 and selector.get('app') != 'payments'
        results['c_svc_backends'] = healthy and selector.get('app') == 'payments' and count >= 2 and any(
            x.get('port') == 80 for x in field(svc,'spec','ports',default=[]))
        # No temporary pods created: use the existing healthy application pod to request its Service.
        results['c_svc_http'] = False
        if results['c_svc_backends']:
            pod_list, err = p.get('pods',ns='exam-network',labels='app=payments')
            pods_ready = [x for x in items(pod_list) if ready_pod(x)]
            if err:
                results['c_svc_http'] = None
            elif pods_ready:
                pod_name = field(pods_ready[0],'metadata','name')
                rc, out, _ = p.exec_pod('exam-network',pod_name,
                                        ['wget','-q','-T','4','-O','-','http://payments-svc'], 10)
                results['c_svc_http'] = (rc == 0 and 'nginx' in out.lower()) if rc is not None else None
    else:
        for k in ('c_svc_bad','c_svc_backends','c_svc_http'):
            results[k] = False

    pvc, pce = p.get('pvc','app-data',ns='exam-storage')
    pv, pve = p.get('pv','lab8-pv')
    app, ae = p.get('pod','storage-api',ns='exam-storage')
    if any(e and e != 'NOT_FOUND' for e in (pce,pve,ae)):
        for k in ('c_pvc_bad','c_pvc_bound','c_pvc_data'):
            results[k] = None
    elif pvc and pv:
        results['c_pvc_bad'] = (field(pvc,'status','phase') == 'Pending' and
                                field(pvc,'spec','storageClassName') != field(pv,'spec','storageClassName'))
        results['c_pvc_bound'] = (field(pvc,'status','phase') == 'Bound' and
                                  field(pvc,'spec','volumeName') == 'lab8-pv' and
                                  field(pv,'status','phase') == 'Bound' and
                                  field(pvc,'spec','resources','requests','storage') == '500Mi')
        if app and ready_pod(app) and results['c_pvc_bound']:
            rc, out, _ = p.exec_pod('exam-storage','storage-api',['cat','/data/status.txt'])
            results['c_pvc_data'] = out.strip() == 'storage-ready' if rc == 0 else (None if rc is None else False)
        else:
            results['c_pvc_data'] = False
    else:
        for k in ('c_pvc_bad','c_pvc_bound','c_pvc_data'):
            results[k] = False

    check, ce = p.get('pod','scheduler-check',ns='default')
    scheduler, sche = p.get('pods',ns='kube-system',labels='component=kube-scheduler')
    scheduler_ready = any(ready_pod(x) for x in items(scheduler)) if not sche else None
    manifest = Path('/etc/kubernetes/manifests/kube-scheduler.yaml')
    manifest_content = None
    if manifest.exists():
        try:
            manifest_content = manifest.read_text(encoding='utf-8')
        except PermissionError:
            pass
    # Test probe can be Pending briefly for other reasons; require failed scheduler or bad manifest.
    local_broken = (manifest_content is not None and
                    '--kubeconfig=/etc/kubernetes/scheduler-lab8.conf' in manifest_content)
    local_fixed = (manifest_content is not None and
                   '--kubeconfig=/etc/kubernetes/scheduler.conf' in manifest_content and
                   '--kubeconfig=/etc/kubernetes/scheduler-lab8.conf' not in manifest_content)
    if ce and ce != 'NOT_FOUND':
        for k in ('c_cp_bad','c_cp_pod'):
            results[k] = None
    else:
        results['c_cp_bad'] = bool(check and field(check,'spec','nodeName',default='') == '' and
                                   (local_broken or scheduler_ready is False))
        results['c_cp_pod'] = ready_pod(check) if check else False
    results['c_cp_fixed'] = (local_fixed and scheduler_ready is True) if manifest_content is not None else None
    results['c_cp_system'] = scheduler_ready

    # Do not award cleanup before all major recovered states have been credited.
    ns_names = ['exam-scheduling','exam-network','exam-storage']
    ns_values = [p.get('namespace',n) for n in ns_names]
    storage, ste = p.get('storageclass','lab8-local')
    if any(e not in (None,'NOT_FOUND') for _,e in ns_values) or ste not in (None,'NOT_FOUND'):
        results['c_cleanup'] = None
    else:
        clean = (all(e == 'NOT_FOUND' for _,e in ns_values) and
                 pve == 'NOT_FOUND' and ste == 'NOT_FOUND' and ce == 'NOT_FOUND' and
                 results['c_nodes_base'] is True and results['c_system_base'] is True and
                 results['c_api_base'] is True)
        results['c_cleanup'] = clean
    return results


def check_worker(p):
    if host() != 'cka-worker2' and os.environ.get('LAB8_TEST_MODE') != '1':
        return {'w_failure': None, 'w_recovery': None}
    rc, out, _ = p.call(['systemctl','is-active','kubelet'], 6)
    if rc is None:
        return {'w_failure':None, 'w_recovery':None}
    return {'w_failure':rc != 0 and out.strip() != 'active',
            'w_recovery':rc == 0 and out.strip() == 'active'}


def capture(mode, selected=None):
    report, lock, _, _ = paths(mode)
    checks = CONTROL if mode == 'control' else WORKER
    names = {x[0] for x in checks if selected is None or x[1] == selected}
    probe = Probe(mode)
    observations = check_control(probe) if mode == 'control' else check_worker(probe)
    with report_lock(lock):
        d = read_report(report,mode)
        d['checks_run'] += 1
        # Prerequisites can have been accredited in the current same pass.
        for ident, task, points, description, prereqs in checks:
            if ident not in names:
                continue
            result = observations.get(ident)
            prev = d['evidence'].get(ident)
            d['last_observations'][ident] = {'status':status(result), 'at':timestamp()}
            if result is True and all(x in d['evidence'] for x in prereqs):
                if prev is None:
                    d['evidence'][ident] = {'at':timestamp(), 'points':points, 'description':description}
        write_report(report,d)
    return d, observations


def summarize(d, mode, detailed=None):
    checks = CONTROL if mode == 'control' else WORKER
    earned = sum(x[2] for x in checks if x[0] in d.get('evidence',{}))
    print(f'\nLAB 8 — EVALUACIÓN DE INCIDENTES v{VERSION} ({mode}, {d.get("host")})')
    for task in TASK_NAMES:
        subset = [x for x in checks if x[1] == task]
        if not subset:
            continue
        maximum = sum(x[2] for x in subset)
        points = sum(x[2] for x in subset if x[0] in d.get('evidence',{}))
        checked = [d.get('last_observations',{}).get(x[0]) for x in subset]
        state = ('COMPLETADA' if points == maximum else
                 'NO INICIADA / SIN EVIDENCIA' if not any(checked) else
                 'EN PROGRESO / SIN EVIDENCIA COMPLETA')
        print(f'  Tarea {task}: {state:35} {points:2}/{maximum} pts | {TASK_NAMES[task]}')
        if detailed == task:
            for ident, _, pts, label, prereqs in subset:
                obs = d.get('last_observations',{}).get(ident,{}).get('status','NO EVALUADA')
                if ident in d['evidence']:
                    obs = 'PASS ACREDITADO'
                elif obs == 'PASS' and prereqs:
                    obs = 'PENDIENTE DE EVIDENCIA PREVIA'
                print(f'    [{obs}] {label} ({pts} pts)')
    print(f'  TOTAL ACREDITADO: {earned}/{sum(x[2] for x in checks)}')
    print('  Resultado provisional hasta capturar y validar la recuperación de cada incidente.')
    print('  Los informes no revelan causas técnicas ni reemplazan el diagnóstico del participante.\n')


def consolidate(d, file):
    if not file.exists():
        raise RuntimeError(f'No existe reporte del worker: {file}')
    other = json.loads(file.read_text(encoding='utf-8'))
    if (other.get('lab') != 8 or other.get('modo') != 'worker2' or
            other.get('host') != 'cka-worker2' or not isinstance(other.get('evidence'),dict)):
        raise RuntimeError('Reporte worker2 incompatible; no se consolida')
    for key in other['evidence']:
        if key not in {x[0] for x in WORKER}:
            raise RuntimeError('Reporte worker2 contiene controles desconocidos')
    current = sum(x[2] for x in CONTROL if x[0] in d['evidence'])
    worker = sum(x[2] for x in WORKER if x[0] in other['evidence'])
    print('\nLAB 8 — CALIFICACIÓN CONSOLIDADA')
    print(f'  cka-control : {current}/90')
    print(f'  cka-worker2: {worker}/10')
    print(f'  TOTAL      : {current + worker}/100')
    output = ROOT / 'reporte_lab8_consolidado.json'
    payload = {'lab':8,'version':VERSION,'at':timestamp(), 'control_points':current,
               'worker2_points':worker,'total_points':current+worker,
               'control_report':d, 'worker2_report':other}
    fd, tmp = tempfile.mkstemp(prefix='.lab8sum-',dir=ROOT)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as f:
            json.dump(payload,f,ensure_ascii=False,indent=2)
            f.write('\n')
        os.replace(tmp,output)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    print(f'  Archivo    : {output}\n')


def alive(pid):
    try:
        os.kill(pid,0)
        # Zombie is not running the monitor.
        stat_text = Path(f'/proc/{pid}/stat')
        if stat_text.exists() and stat_text.read_text().split()[2] == 'Z':
            return False
        return True
    except (OSError, ValueError, ProcessLookupError):
        return False


def read_pid(p):
    try:
        return int(p.read_text().strip())
    except (OSError,ValueError):
        return None


def monitor_loop(mode):
    _,_,pid,log = paths(mode)
    should_stop = False
    def stop(_signum,_frame):
        nonlocal should_stop
        should_stop = True
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    try:
        while not should_stop:
            try:
                capture(mode)
            except Exception as exc:
                with log.open('a',encoding='utf-8') as f:
                    f.write(f'{timestamp()} ERROR {type(exc).__name__}: {str(exc)[:180]}\n')
            for _ in range(INTERVAL):
                if should_stop: break
                time.sleep(1)
    finally:
        if read_pid(pid) == os.getpid():
            pid.unlink(missing_ok=True)


def start_monitor(mode):
    _,_,pid,log = paths(mode)
    previous = read_pid(pid)
    if previous and alive(previous):
        print(f'Monitor ya está activo (PID {previous}); no se inicia otro.')
        return
    if previous:
        pid.unlink(missing_ok=True)
    with log.open('a',encoding='utf-8') as out:
        proc = subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--modo',mode,'--_monitor'],
                                stdin=subprocess.DEVNULL,stdout=out,stderr=out,
                                start_new_session=True,cwd=ROOT)
    pid.write_text(str(proc.pid)+'\n',encoding='utf-8')
    time.sleep(0.25)
    print(f'Monitor iniciado en {mode}, PID {proc.pid}. Ciclo aproximado: {INTERVAL}s.')
    print('Captura explícita recomendable inmediatamente después de cada falla: --capturar')


def stop_monitor(mode):
    _,_,pid,_ = paths(mode)
    value = read_pid(pid)
    if not value or not alive(value):
        pid.unlink(missing_ok=True)
        print('Monitor detenido / no activo.')
        return
    os.kill(value,signal.SIGTERM)
    for _ in range(30):
        if not alive(value): break
        time.sleep(0.1)
    if not alive(value): pid.unlink(missing_ok=True)
    print('Solicitud de detención enviada. Comprueba con --estado.')


def selftest():
    assert sum(x[2] for x in CONTROL) == 90
    assert sum(x[2] for x in WORKER) == 10
    assert set(sum(([x[0]] for x in CONTROL + WORKER),[])) == {x[0] for x in CONTROL+WORKER}
    assert all(set(x[4]).issubset({a[0] for a in CONTROL + WORKER}) for x in CONTROL+WORKER)
    assert endpoints_ready({'items':[{'endpoints':[{'addresses':['10.0.0.1'],'conditions':{'ready':True}},
                                                   {'addresses':['10.0.0.2'],'conditions':{'ready':False}}]}]}) == 1
    assert ready_node({'status':{'conditions':[{'type':'Ready','status':'True'}]}})
    assert not ready_pod({'status':{'phase':'Pending','conditions':[]}})
    assert deployment_ok({'spec':{'replicas':2},'status':{'readyReplicas':2,'availableReplicas':2}})
    print(f'AUTOPRUEBA OK — v{VERSION}; {len(CONTROL)} controles control (90 pts), '
          f'{len(WORKER)} controles worker2 (10 pts), total 100.')


def main():
    parser = argparse.ArgumentParser(description='Evaluador de solo lectura Lab 8 — CKA-Priv')
    group = parser.add_mutually_exclusive_group(required=True)
    for name in ('autoprueba','iniciar','estado','capturar','completo','resumen','detener'):
        group.add_argument('--'+name,action='store_true')
    group.add_argument('--tarea',type=int,choices=range(1,8),metavar='{1..7}')
    group.add_argument('--consolidar',type=Path,metavar='REPORTE_WORKER2')
    group.add_argument('--_monitor',action='store_true',help=argparse.SUPPRESS)
    parser.add_argument('--modo',choices=('auto','control','worker2'),default='auto')
    args = parser.parse_args()
    if args.autoprueba:
        selftest()
        return
    mode = determine_mode(args.modo)
    if args._monitor:
        monitor_loop(mode)
        return
    report,_,pid,log = paths(mode)
    if args.iniciar:
        start_monitor(mode)
    elif args.estado:
        val = read_pid(pid)
        print('Monitor:',f'ACTIVO (PID {val})' if val and alive(val) else 'DETENIDO')
        print('Reporte:', report, '| Existe:',report.exists())
        if log.exists():
            print('Log de errores:',log)
    elif args.detener:
        stop_monitor(mode)
    elif args.resumen:
        summarize(read_report(report,mode),mode)
    elif args.consolidar is not None:
        if mode != 'control':
            raise RuntimeError('--consolidar solo se ejecuta en cka-control')
        consolidate(read_report(report,mode),args.consolidar)
    else:
        d, obs = capture(mode,selected=args.tarea)
        summarize(d,mode,detailed=args.tarea)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError,OSError,ValueError) as exc:
        print('ERROR:',exc,file=sys.stderr)
        sys.exit(2)
