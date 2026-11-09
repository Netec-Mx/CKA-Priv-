#!/usr/bin/env python3
"""CKA Priv — Laboratorio 7, evaluador de solo lectura v1.0.0.

Ejecutar el MISMO archivo en cka-control y en el worker elegido.
Monitorizar antes de la primera tarea para preservar los estados transitorios.
No se crean, modifican ni eliminan recursos de Kubernetes.
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
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager

VERSION = '1.0.0'
BASE = Path(__file__).resolve().parent
INTERVAL = 12
TASKS = {
    1: 'Línea base y preparación de almacenamiento',
    2: 'StorageClass, PV, PVC y Pod',
    3: 'Diagnóstico y persistencia',
    4: 'StorageClass incompatible',
    5: 'Capacidad insuficiente',
    6: 'Access mode incompatible',
    7: 'Conflicto de node affinity',
    8: 'Recuperación y limpieza',
}
# (identificador, tarea, puntos, descripción)
CONTROL = [
    ('c_nodes',1,3,'Nodos operativos y Ready'),
    ('c_workers',1,2,'Dos workers disponibles'),
    ('c_ns',1,3,'Namespace storage-lab'),
    ('c_sc',2,3,'StorageClass manual WaitForFirstConsumer'),
    ('c_pv',2,4,'PV de 1Gi local con RWO y afinidad'),
    ('c_pvc',2,4,'data-pvc Bound con pv-cka-local'),
    ('c_pod',2,4,'storage-app Ready en el worker del PV'),
    ('c_file',2,3,'storage-app lee cka-storage-ok'),
    ('c_binding',3,3,'Binding PV/PVC bidireccional'),
    ('c_retain',3,2,'ReclaimPolicy Retain'),
    ('c_affinity',3,3,'nodeAffinity identifica worker de PV'),
    ('c_placement',3,2,'Pod programado en worker del PV'),
    ('c_class_bad',4,5,'class-broken Pending con cka-fast'),
    ('c_class_fixed',4,7,'class-fixed usa cka-local tras falla'),
    ('c_small',5,3,'PV pv-small de 300Mi en worker correcto'),
    ('c_capacity_bad',5,5,'too-large 700Mi Pending y consumidor Pending'),
    ('c_capacity_fixed',5,4,'capacity-fixed solicita 200Mi tras falla'),
    ('c_access_bad',6,5,'access-broken RWMany Pending frente a PV RWO'),
    ('c_access_fixed',6,7,'access-fixed RWO tras falla'),
    ('c_node_bad',7,6,'node-broken Pending por node affinity incompatible'),
    ('c_node_fixed',7,8,'node-fixed Ready en worker del PV tras falla'),
    ('c_both_data',8,2,'Ambos Pods recuperan el dato persistente'),
    ('c_cleanup',8,2,'Limpieza Kubernetes con nodos saludables'),
]
WORKER = [
    ('w_storage',1,4,'Directorio principal accesible con permisos 0777'),
    ('w_small',5,4,'Directorio para PV de 300Mi con permisos 0777'),
    ('w_cleanup',8,2,'Ambos directorios locales eliminados'),
]
assert sum(x[2] for x in CONTROL) == 90
assert sum(x[2] for x in WORKER) == 10


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def hostname():
    return socket.gethostname().split('.')[0]


def mode_of(args):
    if args.modo != 'auto':
        return args.modo
    name = hostname().lower()
    if name == 'cka-control':
        return 'control'
    if name.startswith('cka-worker'):
        return 'worker'
    raise SystemExit('No se reconoce este host. Usa --modo control o --modo worker explícitamente.')


def paths(mode):
    suffix = 'control' if mode == 'control' else 'worker'
    return (BASE / ('reporte_lab7_' + suffix + '.json'),
            BASE / ('.evaluar_lab7_' + suffix + '.lock'),
            BASE / ('.evaluar_lab7_' + suffix + '.pid'),
            BASE / ('.evaluar_lab7_' + suffix + '.log'))


@contextmanager
def lock_file(p):
    with open(p, 'a+', encoding='utf-8') as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def blank(mode):
    return {'version': VERSION, 'lab': 7, 'modo': mode, 'hostname': hostname(),
            'created_at': now(), 'updated_at': now(), 'evidence': {},
            'pv_worker': None, 'checks_run': 0}


def load(p, mode):
    if not p.exists():
        return blank(mode)
    d = json.loads(p.read_text(encoding='utf-8'))
    if d.get('lab') != 7 or d.get('modo') != mode or not isinstance(d.get('evidence'),dict):
        raise RuntimeError('Reporte incompatible; no se sobrescribió: ' + str(p))
    if d.get('hostname') != hostname():
        raise RuntimeError('El reporte pertenece a otro host. No se sobrescribió: ' + str(p))
    return d


def save(p, data):
    data['updated_at'] = now()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.lab7.', dir=p.parent)
    try:
        os.fchmod(fd, 0o600)
        # Si se ejecuta con sudo, entregar el reporte al usuario original para scp.
        if os.geteuid() == 0 and os.environ.get('SUDO_UID'):
            try:
                os.fchown(fd, int(os.environ['SUDO_UID']), int(os.environ.get('SUDO_GID', '-1')))
            except (OSError, ValueError):
                pass
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def command(argv, timeout=7):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                           check=False, errors='replace')
        return (r.returncode == 0, r.stdout, r.stderr.strip())
    except (OSError, subprocess.TimeoutExpired) as e:
        return (False, '', type(e).__name__ + ': ' + str(e)[:160])


def kubectl(kind, name=None, namespace=None):
    argv = ['kubectl', '--request-timeout=5s', 'get', kind]
    if name:
        argv.append(name)
    if namespace:
        argv += ['-n', namespace]
    argv += ['-o', 'json']
    ok, out, err = command(argv, timeout=8)
    if ok:
        try:
            return json.loads(out), None
        except (ValueError, TypeError) as e:
            return None, 'Respuesta JSON inválida: ' + str(e)
    if '(NotFound)' in err or 'Error from server (NotFound)' in err:
        return None, 'NOT_FOUND'
    return None, 'kubectl: ' + (err[:180] or 'falló la consulta')


def norm_resource(o, path, default=None):
    for k in path.split('.'):
        if not isinstance(o, dict):
            return default
        o = o.get(k)
    return default if o is None else o


def gib(v):
    if not isinstance(v, str):
        return 0
    try:
        if v.endswith('Gi'): return int(v[:-2]) * 1024
        if v.endswith('Mi'): return int(v[:-2])
        if v.endswith('Ki'): return int(v[:-2]) / 1024
    except ValueError:
        return 0
    return 0


def node_ready(n):
    return any(c.get('type') == 'Ready' and c.get('status') == 'True'
               for c in n.get('status', {}).get('conditions', []))


def is_pod_ready(p):
    return p.get('status',{}).get('phase') == 'Running' and any(
        c.get('type') == 'Ready' and c.get('status') == 'True'
        for c in p.get('status',{}).get('conditions', []))


def pv_worker(pv):
    terms = norm_resource(pv, 'spec.nodeAffinity.required.nodeSelectorTerms', [])
    if not isinstance(terms, list): return None
    for t in terms:
        for expr in t.get('matchExpressions',[]):
            if expr.get('key') == 'kubernetes.io/hostname' and expr.get('operator') == 'In':
                values = expr.get('values', [])
                if len(values) == 1:
                    return values[0]
    return None


def pv_local(pv, name, cap, path):
    return bool(pv and pv.get('metadata',{}).get('name') == name and
                norm_resource(pv, 'spec.storageClassName') == 'cka-local' and
                norm_resource(pv, 'spec.local.path') == path and
                gib(norm_resource(pv, 'spec.capacity.storage')) == cap and
                norm_resource(pv, 'spec.accessModes') == ['ReadWriteOnce'] and pv_worker(pv))


def pod_pvc(p, claim):
    return any(norm_resource(v, 'persistentVolumeClaim.claimName') == claim
               for v in norm_resource(p, 'spec.volumes', []))


def pod_data(name):
    ok, stdout, err = command(['kubectl', '--request-timeout=5s', 'exec', '-n', 'storage-lab',
                                name, '--', 'cat', '/data/status.txt'], timeout=9)
    return ok and stdout.strip() == 'cka-storage-ok', err


def candidate_worker(pv, nodes):
    w = pv_worker(pv) if pv else None
    if not w: return None
    return w if any(n.get('metadata',{}).get('name') == w for n in nodes) else None


def evaluate_control(data, only=None):
    # No more than one full read of any resource per evaluation pass.
    wanted = [x for x in CONTROL if only is None or x[1] == only]
    if not wanted: return {}
    cache = {}
    def get(kind, name=None, ns=None):
        key = (kind, name, ns)
        if key not in cache: cache[key] = kubectl(kind, name, ns)
        return cache[key]
    def obj(kind, name=None, ns=None): return get(kind,name,ns)[0]
    def missing(*keys):
        for kind,name,ns in keys:
            o,e = get(kind,name,ns)
            if e and e != 'NOT_FOUND': return 'UNVERIFIED', e
        return None
    nodes_obj = obj('nodes')
    nodes = nodes_obj.get('items',[]) if nodes_obj else []
    n_err = get('nodes')[1]
    pv = obj('pv', 'pv-cka-local')
    worker = candidate_worker(pv, nodes)
    if worker:
        data['pv_worker'] = worker
    elif data.get('pv_worker'):
        worker = data['pv_worker']
    pvc = obj('pvc','data-pvc','storage-lab')
    pod = obj('pod','storage-app','storage-lab')
    small = obj('pv','pv-small')
    old = data.get('evidence',{})
    def passed(id): return old.get(id,{}).get('passed') is True
    def pred(ok, why='No coincide con el resultado esperado'):
        return ('PASS','Verificado') if ok else ('FAIL',why)
    def pending_check(o, e, why):
        if o is None:
            return ('UNVERIFIED',e) if e != 'NOT_FOUND' else ('FAIL','Recurso aún no creado')
        return pred(o.get('status',{}).get('phase') == 'Pending', why)
    results={}
    for id, task, pts, desc in wanted:
        # Return an explicit transient-unverified status when the API is unreachable.
        if n_err and n_err != 'NOT_FOUND':
            results[id] = ('UNVERIFIED',n_err); continue
        if id == 'c_nodes':
            result=pred(len(nodes)>=3 and all(node_ready(n) for n in nodes), 'Nodos ausentes o NotReady')
        elif id == 'c_workers':
            workers=[n for n in nodes if not any(k.startswith('node-role.kubernetes.io/control-plane')
                     for k in n.get('metadata',{}).get('labels',{}))]
            result=pred(len(workers)>=2 and all(node_ready(n) for n in workers), 'Se requieren dos workers Ready')
        elif id == 'c_ns':
            ns=obj('namespace','storage-lab'); result=pred(bool(ns and ns.get('status',{}).get('phase')=='Active'))
        elif id == 'c_sc':
            sc=obj('storageclass','cka-local')
            result=pred(bool(sc and norm_resource(sc,'provisioner')=='kubernetes.io/no-provisioner' and
                         norm_resource(sc,'volumeBindingMode')=='WaitForFirstConsumer'))
        elif id == 'c_pv':
            result=pred(pv_local(pv,'pv-cka-local',1024,'/mnt/cka-storage'))
        elif id == 'c_pvc':
            result=pred(bool(pvc and norm_resource(pvc,'status.phase')=='Bound' and
                             norm_resource(pvc,'spec.volumeName')=='pv-cka-local'))
        elif id == 'c_pod':
            result=pred(bool(pod and worker and is_pod_ready(pod) and
                             norm_resource(pod,'spec.nodeName')==worker and pod_pvc(pod,'data-pvc')))
        elif id == 'c_file':
            if not pod or not is_pod_ready(pod): result=('FAIL','Pod storage-app no disponible')
            else:
                ok,err=pod_data('storage-app'); result=pred(ok,err or 'Archivo persistente incorrecto')
        elif id == 'c_binding':
            result=pred(bool(pv and pvc and norm_resource(pv,'spec.claimRef.name')=='data-pvc' and
                            norm_resource(pv,'spec.claimRef.namespace')=='storage-lab' and
                            norm_resource(pvc,'spec.volumeName')=='pv-cka-local'))
        elif id == 'c_retain':
            result=pred(bool(pv and norm_resource(pv,'spec.persistentVolumeReclaimPolicy')=='Retain'))
        elif id == 'c_affinity':
            result=pred(bool(pv and worker and norm_resource(pv,'spec.local.path')=='/mnt/cka-storage'))
        elif id == 'c_placement':
            result=pred(bool(pod and worker and norm_resource(pod,'spec.nodeName')==worker))
        elif id == 'c_class_bad':
            b=obj('pvc','class-broken','storage-lab')
            result=pred(bool(b and norm_resource(b,'spec.storageClassName')=='cka-fast' and
                             norm_resource(b,'status.phase')=='Pending'), 'No se observó class-broken Pending con cka-fast')
        elif id == 'c_class_fixed':
            f=obj('pvc','class-fixed','storage-lab')
            result=pred(bool(passed('c_class_bad') and f and
                             norm_resource(f,'spec.storageClassName')=='cka-local' and
                             'ReadWriteOnce' in norm_resource(f,'spec.accessModes',[]) and
                             gib(norm_resource(f,'spec.resources.requests.storage'))==200),
                        'Falta falla previa o PVC corregido (puede continuar Pending)')
        elif id == 'c_small':
            result=pred(pv_local(small,'pv-small',300,'/mnt/cka-storage-small') and
                        (not worker or pv_worker(small)==worker))
        elif id == 'c_capacity_bad':
            b=obj('pvc','too-large','storage-lab'); test=obj('pod','capacity-test','storage-lab')
            result=pred(bool(passed('c_small') and b and test and
                            norm_resource(b,'status.phase')=='Pending' and
                            gib(norm_resource(b,'spec.resources.requests.storage'))==700 and
                            norm_resource(test,'status.phase')=='Pending' and pod_pvc(test,'too-large')),
                        'Debe observarse PVC 700Mi y Pod consumidor Pending, con PV de 300Mi')
        elif id == 'c_capacity_fixed':
            f=obj('pvc','capacity-fixed','storage-lab')
            result=pred(bool(passed('c_capacity_bad') and f and
                        norm_resource(f,'spec.storageClassName')=='cka-local' and
                        gib(norm_resource(f,'spec.resources.requests.storage'))==200 and
                        'ReadWriteOnce' in norm_resource(f,'spec.accessModes',[])),
                        'Falta estado defectuoso o solicitud corregida de 200Mi')
        elif id == 'c_access_bad':
            b=obj('pvc','access-broken','storage-lab')
            result=pred(bool(b and norm_resource(b,'status.phase')=='Pending' and
                        'ReadWriteMany' in norm_resource(b,'spec.accessModes',[]) and
                        norm_resource(b,'spec.storageClassName')=='cka-local' and
                        pv and norm_resource(pv,'spec.accessModes')==['ReadWriteOnce']),
                        'Debe observarse RWMany Pending frente a PV RWO')
        elif id == 'c_access_fixed':
            f=obj('pvc','access-fixed','storage-lab')
            result=pred(bool(passed('c_access_bad') and f and
                        norm_resource(f,'spec.accessModes')==['ReadWriteOnce'] and
                        norm_resource(f,'spec.storageClassName')=='cka-local'),
                        'Falta falla previa o claim corregido con RWO')
        elif id == 'c_node_bad':
            b=obj('pod','node-broken','storage-lab')
            # Las etiquetas de Kubernetes incluyen '/' como parte de una clave literal.
            forced=(b or {}).get('spec',{}).get('nodeSelector',{}).get('kubernetes.io/hostname')
            result=pred(bool(b and worker and forced and forced!=worker and
                        norm_resource(b,'status.phase')=='Pending' and pod_pvc(b,'data-pvc')),
                        'No se observó Pod Pending forzado al worker incompatible')
        elif id == 'c_node_fixed':
            f=obj('pod','node-fixed','storage-lab')
            result=pred(bool(passed('c_node_bad') and f and worker and is_pod_ready(f) and
                        norm_resource(f,'spec.nodeName')==worker and pod_pvc(f,'data-pvc') and
                        'kubernetes.io/hostname' not in f.get('spec',{}).get('nodeSelector',{})),
                        'Falta falla previa o Pod node-fixed Ready en worker del PV')
        elif id == 'c_both_data':
            if not passed('c_node_fixed') or not pod or not obj('pod','node-fixed','storage-lab'):
                result=('FAIL','Primero recupera node-fixed y ambos Pods')
            else:
                a,_=pod_data('storage-app'); b,_=pod_data('node-fixed')
                result=pred(a and b,'Ambos Pods deben leer cka-storage-ok')
        elif id == 'c_cleanup':
            ns,err=get('namespace','storage-lab',None)
            missing_ns=ns is None and err=='NOT_FOUND'
            deleted=all(get(k,n,None)[1]=='NOT_FOUND' for k,n in
                        [('pv','pv-cka-local'),('pv','pv-small'),('storageclass','cka-local')])
            result=pred(bool(passed('c_both_data') and missing_ns and deleted and
                             len(nodes)>=3 and all(node_ready(n) for n in nodes)),
                        'Primero acreditar persistencia, luego eliminar recursos manteniendo nodos Ready')
        else:
            result=('UNVERIFIED','Verificación no implementada')
        # Avoid calling a missing resource a failure when the API itself is unavailable.
        if result[0]=='FAIL':
            dependent = {
                'c_ns':[('namespace','storage-lab',None)],
                'c_sc':[('storageclass','cka-local',None)],
                'c_pv':[('pv','pv-cka-local',None)],
                'c_pvc':[('pvc','data-pvc','storage-lab')],
                'c_pod':[('pod','storage-app','storage-lab')],
            }.get(id,[])
            x=missing(*dependent) if dependent else None
            if x: result=x
        results[id]=result
    return results


def dir_status(path):
    try:
        st=Path(path).stat()
        return stat.S_ISDIR(st.st_mode) and stat.S_IMODE(st.st_mode)==0o777
    except (OSError, PermissionError):
        return False


def evaluate_worker(data, only=None):
    wanted=[x for x in WORKER if only is None or x[1]==only]
    e=data.get('evidence',{})
    results={}
    for id,task,pts,desc in wanted:
        if id=='w_storage':
            ok=dir_status('/mnt/cka-storage')
            results[id]=('PASS','Directorio local 0777') if ok else ('FAIL','Falta /mnt/cka-storage con modo 0777')
        elif id=='w_small':
            ok=dir_status('/mnt/cka-storage-small')
            results[id]=('PASS','Directorio pequeño 0777') if ok else ('FAIL','Falta /mnt/cka-storage-small con modo 0777')
        elif id=='w_cleanup':
            previously=e.get('w_storage',{}).get('passed') and e.get('w_small',{}).get('passed')
            absent=not Path('/mnt/cka-storage').exists() and not Path('/mnt/cka-storage-small').exists()
            results[id]=('PASS','Ambos directorios eliminados') if previously and absent else (
                'FAIL','Necesita evidencia previa de ambos directorios y eliminación posterior')
    return results


def perform(mode, task=None):
    report,lock,_,_=paths(mode)
    with lock_file(lock):
        d=load(report,mode)
        res=evaluate_control(d,task) if mode=='control' else evaluate_worker(d,task)
        d['checks_run']+=1
        for key,(state,reason) in res.items():
            entry=d['evidence'].setdefault(key,{})
            entry['last_state']=state
            entry['last_reason']=reason[:240]
            entry['checked_at']=now()
            if state=='PASS' and not entry.get('passed'):
                entry['passed']=True
                entry['passed_at']=now()
        save(report,d)
        return d


def totals(d, specs):
    e=d.get('evidence',{})
    return sum(p for id,t,p,desc in specs if e.get(id,{}).get('passed') is True)


def print_report(d, task=None):
    mode=d['modo']; specs=CONTROL if mode=='control' else WORKER
    print('\nLAB 7 — EVALUACIÓN DE ALMACENAMIENTO (v%s, %s)'%(VERSION,mode.upper()))
    print('Host: %s | Evidencias acumuladas | %s'%(d.get('hostname'),d.get('updated_at')))
    if mode=='control':
        print('Worker del PV:',d.get('pv_worker') or 'Aún no identificado')
    for t,name in TASKS.items():
        rows=[x for x in specs if x[1]==t]
        if not rows: continue
        ev=d.get('evidence',{})
        possible=sum(x[2] for x in rows)
        score=sum(p for id,_,p,_ in rows if ev.get(id,{}).get('passed'))
        done=sum(bool(ev.get(id,{}).get('passed')) for id,_,p,_ in rows)
        seen=sum(id in ev for id,_,p,_ in rows)
        state='COMPLETADA' if done==len(rows) else ('NO INICIADA / SIN EVIDENCIA' if seen==0 else 'EN PROGRESO')
        if task is None or task==t:
            print('  Tarea %d: %-27s %d/%d pts | %s'%(t,state,score,possible,name))
        if task==t:
            for id,_,pts,desc in rows:
                item=ev.get(id,{})
                label='PASS' if item.get('passed') else item.get('last_state','NO EVALUADA')
                note=(' — '+item.get('last_reason','')) if label not in ('PASS','NO EVALUADA') else ''
                print('    [%s] %s (%d pts)%s'%(label,desc,pts,note))
    print('  PUNTOS ACREDITADOS: %d/%d'%(totals(d,specs),sum(x[2] for x in specs)))
    print('  Nota: no observar una fase transitoria no demuestra que el participante no la realizó.')
    print('  El monitor no cambia recursos ni certifica los comandos exactos ejecutados.')


def monitor_running(pidfile):
    if not pidfile.exists(): return None
    try:
        pid=int(pidfile.read_text(encoding='ascii').strip())
        cmdline=Path('/proc/%d/cmdline'%pid).read_bytes().replace(b'\x00',b' ')
        if b'evaluar_lab7.py' not in cmdline or b'--_monitor' not in cmdline:
            return None
        return pid
    except (ValueError,OSError):
        return None


def start(mode):
    report, lock, pidfile, logfile=paths(mode)
    if monitor_running(pidfile):
        print('Monitor ya activo, PID',monitor_running(pidfile)); return
    with open(logfile,'ab') as f:
        p=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--modo',mode,'--_monitor'],
                           cwd=str(BASE),stdin=subprocess.DEVNULL,stdout=f,stderr=f,start_new_session=True)
    pidfile.write_text(str(p.pid),encoding='ascii')
    print('Monitor iniciado en %s (PID %d). Intervalo %d s.'%(mode,p.pid,INTERVAL))
    print('Reporte:',report)
    print('Ejecuta --estado y --capturar durante cada falla transitoria.')


def stop(mode):
    _,_,pidfile,_=paths(mode)
    pid=monitor_running(pidfile)
    if pid:
        os.kill(pid,signal.SIGTERM)
        print('Se solicitó detener el monitor PID',pid)
    else:
        print('No había un monitor activo.')
    pidfile.unlink(missing_ok=True)


def run_monitor(mode):
    def terminate(signum,frame): raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,terminate)
    signal.signal(signal.SIGINT,terminate)
    try:
        while True:
            try: perform(mode)
            except Exception as e:
                print(now(),type(e).__name__,str(e)[:150],flush=True)
            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        pass


def consolidate(path):
    control_report,_,_,_=paths('control')
    c=load(control_report,'control')
    w=json.loads(Path(path).read_text(encoding='utf-8'))
    if w.get('lab')!=7 or w.get('modo')!='worker' or not isinstance(w.get('evidence'),dict):
        raise SystemExit('No es un reporte válido de Lab 7 worker.')
    expected=c.get('pv_worker')
    if not expected:
        raise SystemExit('No hay evidencia del worker usado por el PV. Captura el PV antes de eliminarlo.')
    if expected!=w.get('hostname'):
        raise SystemExit('Worker incompatible: PV está en %s, reporte corresponde a %s'%(expected,w.get('hostname')))
    cs,ws=totals(c,CONTROL),totals(w,WORKER)
    print('\nLAB 7 — CALIFICACIÓN CONSOLIDADA')
    print('Control (%s): %d/90'%(c['hostname'],cs))
    print('Worker (%s): %d/10'%(w['hostname'],ws))
    print('TOTAL ACREDITADO: %d/100'%(cs+ws))
    for t,name in TASKS.items():
        specs=[x for x in CONTROL if x[1]==t]+[x for x in WORKER if x[1]==t]
        possible=sum(x[2] for x in specs)
        score=sum(p for id,_,p,_ in specs if (c if id.startswith('c_') else w).get('evidence',{}).get(id,{}).get('passed'))
        print('  Tarea %d: %d/%d | %s'%(t,score,possible,name))
    print('Calificación basada en evidencia capturada, no equivale a demostrar ejecución de comandos.')


def selftest():
    assert sum(x[2] for x in CONTROL+WORKER)==100
    assert len(set(x[0] for x in CONTROL+WORKER))==len(CONTROL+WORKER)
    assert gib('1Gi')==1024 and gib('300Mi')==300
    sample={'spec':{'nodeAffinity':{'required':{'nodeSelectorTerms':[
        {'matchExpressions':[{'key':'kubernetes.io/hostname','operator':'In','values':['cka-worker2']}]}]}}}}
    assert pv_worker(sample)=='cka-worker2'
    assert is_pod_ready({'status':{'phase':'Running','conditions':[{'type':'Ready','status':'True'}]}})
    assert not is_pod_ready({'status':{'phase':'Pending'}})
    assert pod_pvc({'spec':{'volumes':[{'persistentVolumeClaim':{'claimName':'data-pvc'}}]}},'data-pvc')
    with tempfile.TemporaryDirectory() as folder:
        dest=Path(folder)/'r.json'
        data=blank('control'); save(dest,data)
        assert json.loads(dest.read_text())['lab']==7
    print('AUTOPRUEBA OK — v%s, %d controles control / %d worker, 90+10=100 puntos.'%
          (VERSION,len(CONTROL),len(WORKER)))


def main():
    p=argparse.ArgumentParser(description='Evaluador Lab 7 CKA, solo lectura')
    p.add_argument('--modo',choices=['auto','control','worker'],default='auto',
                   help='Detecta cka-control/cka-workerN; permite forzar modo')
    group=p.add_mutually_exclusive_group(required=True)
    for opt in ['iniciar','estado','capturar','completo','resumen','detener','autoprueba']:
        group.add_argument('--'+opt,action='store_true')
    group.add_argument('--tarea',type=int,choices=range(1,9),metavar='1..8')
    group.add_argument('--consolidar',metavar='REPORTE_WORKER_JSON')
    group.add_argument('--_monitor',action='store_true',help=argparse.SUPPRESS)
    args=p.parse_args()
    if args.autoprueba: selftest(); return
    if args.consolidar: consolidate(args.consolidar); return
    mode=mode_of(args)
    if args._monitor: run_monitor(mode); return
    report,lock,pidfile,logfile=paths(mode)
    if args.iniciar: start(mode); return
    if args.detener: stop(mode); return
    if args.estado:
        pid=monitor_running(pidfile)
        print('Monitor:',('ACTIVO (PID %s)'%pid) if pid else 'DETENIDO')
        print('Reporte:',report)
        if report.exists():
            with lock_file(lock): print_report(load(report,mode))
        return
    if args.resumen:
        with lock_file(lock): print_report(load(report,mode))
        return
    if args.tarea or args.capturar or args.completo:
        data=perform(mode,args.tarea)
        print_report(data,args.tarea)
        return


if __name__=='__main__':
    try:
        main()
    except (RuntimeError,OSError,ValueError,json.JSONDecodeError) as e:
        print('ERROR:',str(e),file=sys.stderr)
        sys.exit(2)
