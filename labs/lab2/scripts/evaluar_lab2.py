#!/usr/bin/env python3
"""Evaluación local, de solo lectura, de CKA-Priv Lab 2.

Uso: python3 evaluar_lab2.py --iniciar   # antes de realizar lab2
     python3 evaluar_lab2.py --completo # estado actual y evidencia acumulada
     python3 evaluar_lab2.py --resumen  # solo evidencia registrada
     python3 evaluar_lab2.py --detener  # fin de captura
"""
import argparse
import datetime as dt
import json
import os
import signal
import time
from pathlib import Path
import socket
import subprocess
import sys

VERSION = '3.0.0'
CONTEXT = 'kubernetes-admin@kubernetes'
WORKER = 'cka-worker1'
CONTROL = 'cka-control'
NAMESPACE = 'lab2'
DEPLOYMENT = 'maintenance-app'
REPORT = Path(__file__).resolve().parent / 'reporte_lab2.json'
PID_FILE = REPORT.with_name('evaluar_lab2_monitor.pid')
MONITOR_LOG = REPORT.with_name('evaluar_lab2_monitor.log')
WEIGHTS = {'1': 20, '2': 20, '3': 25, '4': 15, '5:drenado': 9, '5:restaurado': 7, '5:final': 4}
ORDER = list(WEIGHTS)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def command(args, timeout=20):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f'No pudo ejecutarse {args[0]}: {exc}') from exc
    if p.returncode:
        raise RuntimeError((p.stderr or p.stdout).strip()[:500] or f'código {p.returncode}')
    return p.stdout


def kube(*args):
    return command(['kubectl', '--request-timeout=12s', *args])


def get_json(*args):
    return json.loads(kube(*args, '-o', 'json'))


def nodes():
    return {n['metadata']['name']: n for n in get_json('get', 'nodes')['items']}


def ready(node):
    return any(c.get('type') == 'Ready' and c.get('status') == 'True'
               for c in node.get('status', {}).get('conditions', []))


def schedulable(node):
    return not node.get('spec', {}).get('unschedulable', False)


def pods(namespace=NAMESPACE, label=None):
    args = ['get', 'pods', '-n', namespace]
    if label:
        args += ['-l', label]
    return get_json(*args)['items']


def apppods():
    return pods(label='app=maintenance-app')


def app_available():
    d = get_json('get', 'deployment', DEPLOYMENT, '-n', NAMESPACE)
    spec = d.get('spec', {})
    status = d.get('status', {})
    return spec.get('replicas') == 3 and status.get('readyReplicas', 0) == 3 and status.get('availableReplicas', 0) == 3


def app_placement(node):
    ap = apppods()
    return len(ap) == 3 and all(p.get('spec', {}).get('nodeName') == node and
                                  p.get('status', {}).get('phase') == 'Running'
                                  for p in ap)


def app_uids():
    return sorted(p['metadata']['uid'] for p in apppods())


def app_preferred_worker():
    d = get_json('get', 'deployment', DEPLOYMENT, '-n', NAMESPACE)
    spec = d['spec']['template']['spec']
    affinity = spec.get('affinity', {}).get('nodeAffinity', {}).get('preferredDuringSchedulingIgnoredDuringExecution', [])
    preference = any(
        term.get('weight', 0) > 0 and any(
            expr.get('key') == 'kubernetes.io/hostname' and expr.get('operator') == 'In'
            and WORKER in expr.get('values', [])
            for expr in term.get('preference', {}).get('matchExpressions', []))
        for term in affinity)
    toleration = any(t.get('key') == 'node-role.kubernetes.io/control-plane'
                     and t.get('operator') == 'Exists' and t.get('effect') == 'NoSchedule'
                     for t in spec.get('tolerations', []))
    image = any(c.get('name') == 'web' and c.get('image') == 'nginx:1.27-alpine'
                for c in spec.get('containers', []))
    return preference, toleration, image


def daemonsets_on_worker():
    system = pods('kube-system')
    def has(name):
        return any(p.get('spec', {}).get('nodeName') == WORKER and
                   p.get('status', {}).get('phase') == 'Running' and
                   any(ref.get('kind') == 'DaemonSet' for ref in p.get('metadata', {}).get('ownerReferences', [])) and
                   (p['metadata']['name'].startswith(name) or p.get('metadata', {}).get('labels', {}).get('k8s-app') == name)
                   for p in system)
    return has('kube-proxy'), has('calico-node')


def api_ready():
    return kube('get', '--raw=/readyz').strip() == 'ok'


def namespace_exists():
    # Un listado es preferible a interpretar un error de permisos como ausencia.
    return any(n['metadata']['name'] == NAMESPACE for n in get_json('get', 'namespaces')['items'])


def snapshot_from_report(report, key):
    entry = report.get('etapas', {}).get(key)
    return entry.get('evidencia', {}) if entry else {}


def historical_uids(report, key, field):
    values = snapshot_from_report(report, key).get(field)
    if not values:
        raise RuntimeError(f'Evidencia histórica de {key} ausente; no se puede confirmar esta transición.')
    return values


class Evaluator:
    def __init__(self):
        self.items = []
        self.evidence = {}

    def check(self, name, points, func):
        try:
            ok = bool(func())
            status, detail = ('PASS', 'Condición verificada') if ok else ('FAIL', 'Condición esperada no encontrada')
        except RuntimeError as exc:
            msg = str(exc)[:350]
            if 'NotFound' in msg or 'not found' in msg or 'no matches for kind' in msg:
                status, detail = 'FAIL', 'Recurso requerido ausente: ' + msg
            else:
                status, detail = 'UNVERIFIED', msg
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            status, detail = 'UNVERIFIED', str(exc)[:350]
        self.items.append({'nombre': name, 'puntos': points, 'estado': status, 'detalle': detail})

    def evidence_of(self, name, func):
        try:
            self.evidence[name] = func()
        except (RuntimeError, ValueError, KeyError, TypeError) as exc:
            self.evidence[name + '_error'] = str(exc)[:350]


def check_nodes(e, *, sched):
    e.check('cka-control Ready y programable', 2, lambda: ready(nodes()[CONTROL]) and schedulable(nodes()[CONTROL]))
    e.check('cka-worker1 Ready', 2, lambda: ready(nodes()[WORKER]))
    e.check(f'cka-worker1 {"programable" if sched else "cordoned"}', 3,
            lambda: schedulable(nodes()[WORKER]) == sched)


def phase_1(e, report):
    e.check('Contexto Kubernetes administrativo', 2, lambda: kube('config', 'current-context').strip() == CONTEXT)
    e.check('Nodos cka-control y cka-worker1 Ready; worker2 ausente', 3,
            lambda: set(nodes()) == {CONTROL, WORKER} and all(ready(n) for n in nodes().values()))
    e.check('Worker habilitado para scheduling', 2, lambda: schedulable(nodes()[WORKER]))
    e.check('Namespace lab2 creado', 2, namespace_exists)
    e.check('Deployment 3 réplicas disponibles', 4, app_available)
    e.check('Afinidad preferida hacia worker1', 3, lambda: app_preferred_worker()[0])
    e.check('Toleration del taint del control plane', 2, lambda: app_preferred_worker()[1])
    e.check('Imagen nginx:1.27-alpine en contenedor web', 2, lambda: app_preferred_worker()[2])
    e.evidence_of('pods_iniciales', app_uids)


def phase_2(e, report):
    check_nodes(e, sched=False)  # 7
    e.check('Pod cordon-test en control plane y Running', 5, lambda: (
        (p := get_json('get', 'pod', 'cordon-test', '-n', NAMESPACE))['spec'].get('nodeName') == CONTROL
        and p['status'].get('phase') == 'Running'))
    e.check('Pod temporal tolera control plane', 2, lambda: any(
        t.get('key') == 'node-role.kubernetes.io/control-plane' and t.get('effect') == 'NoSchedule'
        for t in get_json('get', 'pod', 'cordon-test', '-n', NAMESPACE)['spec'].get('tolerations', [])))
    e.check('Deployment continúa con 3 réplicas disponibles', 3, app_available)
    e.check('Pod original sigue sobre worker1 (cordon no evacúa)', 3,
            lambda: historical_uids(report, '1', 'pods_iniciales') and any(p['metadata']['uid'] in historical_uids(report, '1', 'pods_iniciales')
                        and p.get('spec', {}).get('nodeName') == WORKER for p in apppods()))
    e.evidence_of('pods_pre_drain', app_uids)
    e.evidence_of('pods_worker_pre_drain', lambda: sorted(p['metadata']['uid'] for p in apppods()
                                                    if p.get('spec', {}).get('nodeName') == WORKER))


def phase_3(e, report):
    check_nodes(e, sched=False)  # 7
    e.check('Deployment mantiene 3 réplicas disponibles', 4, app_available)
    e.check('Tres réplicas Running en cka-control', 6, lambda: app_placement(CONTROL))
    e.check('Pods originales del worker fueron desalojados', 3,
            lambda: not (set(historical_uids(report, '2', 'pods_worker_pre_drain')) & set(app_uids())))
    e.check('DaemonSet kube-proxy conservado en worker', 2, lambda: daemonsets_on_worker()[0])
    e.check('DaemonSet calico-node conservado en worker', 2, lambda: daemonsets_on_worker()[1])
    e.check('API Server /readyz correcto', 1, api_ready)
    e.evidence_of('pods_post_drain', app_uids)


def phase_4(e, report):
    e.check('Nodos Ready y worker2 no unido', 3,
            lambda: set(nodes()) == {CONTROL, WORKER} and all(ready(n) for n in nodes().values()))
    e.check('Worker reabierto a scheduling (uncordon)', 3, lambda: schedulable(nodes()[WORKER]))
    e.check('Deployment vuelve a tener 3 réplicas disponibles', 4, app_available)
    e.check('Pods nuevos tras rollout restart', 3,
            lambda: not (set(historical_uids(report, '3', 'pods_post_drain')) & set(app_uids())))
    e.check('Al menos una réplica nueva ejecutándose en worker1', 2,
            lambda: any(p.get('spec', {}).get('nodeName') == WORKER and
                        p.get('status', {}).get('phase') == 'Running' for p in apppods()))
    e.evidence_of('pods_post_rollout', app_uids)


def phase_5_drained(e, report):
    e.check('Worker Ready durante el reto', 2, lambda: ready(nodes()[WORKER]))
    e.check('Worker cordoned durante el reto', 2, lambda: not schedulable(nodes()[WORKER]))
    e.check('Aplicación disponible con 3 réplicas', 2, app_available)
    e.check('Pods de aplicación evacuados al control plane', 2, lambda: app_placement(CONTROL))
    e.check('DaemonSets del worker preservados', 1, lambda: all(daemonsets_on_worker()))
    e.evidence_of('pods_reto_drenado', app_uids)


def phase_5_restored(e, report):
    e.check('Worker listo y reabierto a scheduling', 2,
            lambda: ready(nodes()[WORKER]) and schedulable(nodes()[WORKER]))
    e.check('Deployment disponible con 3 réplicas', 2, app_available)
    e.check('Nuevos Pods del Deployment tras el reto', 2,
            lambda: not (set(historical_uids(report, '5:drenado', 'pods_reto_drenado')) & set(app_uids())))
    e.check('Al menos una réplica regresa al worker', 1,
            lambda: any(p['spec'].get('nodeName') == WORKER for p in apppods()))


def phase_5_final(e, report):
    e.check('Namespace lab2 eliminado', 1, lambda: not namespace_exists())
    e.check('Ambos nodos Ready y worker nuevamente programable', 2,
            lambda: set(nodes()) == {CONTROL, WORKER} and all(ready(n) for n in nodes().values())
            and schedulable(nodes()[WORKER]))
    e.check('API Server preparado', 1, api_ready)


PHASES = {'1': phase_1, '2': phase_2, '3': phase_3, '4': phase_4,
          '5:drenado': phase_5_drained, '5:restaurado': phase_5_restored, '5:final': phase_5_final}


def load_report():
    if not REPORT.exists():
        return {'version': VERSION, 'lab_id': 'l002', 'etapas': {}}
    try:
        r = json.loads(REPORT.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f'Reporte ilegible: {exc}') from exc
    if r.get('lab_id') != 'l002' or not isinstance(r.get('etapas'), dict):
        raise RuntimeError('Reporte incompatible con Lab 2; no se sobrescribirá.')
    return r


def save_report(r):
    r['version'] = VERSION
    r['actualizado_utc'] = now()
    tmp = REPORT.with_name(REPORT.name + '.tmp')
    tmp.write_text(json.dumps(r, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    os.replace(tmp, REPORT)


def phase_status(entry):
    if not entry:
        return 'NO INICIADA'
    items = entry['validaciones']
    if all(x['estado'] == 'PASS' for x in items):
        return 'COMPLETADA'
    if any(x['estado'] == 'UNVERIFIED' for x in items):
        return 'NO VERIFICABLE' if all(x['estado'] == 'UNVERIFIED' for x in items) else 'INCOMPLETA'
    if any(x['estado'] == 'PASS' for x in items):
        return 'INCOMPLETA'
    return 'INCOMPLETA'


def task_status(r, task):
    keys = [str(task)] if task != 5 else ORDER[4:]
    available = [r['etapas'].get(k) for k in keys]
    if not any(available):
        return 'NO INICIADA'
    if all(available) and all(phase_status(v) == 'COMPLETADA' for v in available):
        return 'COMPLETADA'
    if any(v and any(x['estado'] == 'FAIL' for x in v['validaciones']) for v in available):
        return 'INCOMPLETA'
    if any(v and any(x['estado'] == 'UNVERIFIED' for x in v['validaciones']) for v in available):
        return 'INCOMPLETA (SIN VERIFICAR)'
    return 'EN PROGRESO'


def show_summary(r):
    print('\nLAB 2 — RESUMEN DE EVALUACIÓN POR TAREAS')
    earned = verified = 0
    for task in range(1, 6):
        keys = [str(task)] if task != 5 else ORDER[4:]
        maximum = sum(WEIGHTS[k] for k in keys)
        points = sum(x['puntos'] for k in keys for x in r['etapas'].get(k, {}).get('validaciones', []) if x['estado']=='PASS')
        earned += points
        verified += sum(x['puntos'] for k in keys for x in r['etapas'].get(k, {}).get('validaciones', []) if x['estado']!='UNVERIFIED')
        print(f'  Tarea {task}: {task_status(r,task):<28} {points:5.1f}/{maximum} puntos')
        if task == 5:
            for key in keys:
                v = r['etapas'].get(key)
                detail = sum(x['puntos'] for x in v['validaciones'] if x['estado']=='PASS') if v else 0
                print(f'    {key:<15} {phase_status(v):<22} {detail}/{WEIGHTS[key]}')
    print(f'  PUNTOS ACREDITADOS: {earned:.1f}/100')
    if all(task_status(r,t) == 'COMPLETADA' for t in range(1,6)):
        print('  ESTADO GENERAL: COMPLETADA — 100%')
    else:
        print('  ESTADO GENERAL: PRÁCTICA NO TERMINADA / EVIDENCIA INSUFICIENTE; sin nota final.')
        print(f'  Evidencia verificada: {verified}/100 puntos; sin captura o sin verificar: {100-verified}/100.')
    print(f'  Reporte: {REPORT}')
    print('  NOTA: NO INICIADA significa SIN EVALUACIÓN REGISTRADA, no prueba de inactividad.')
    print('  Cordon/drain anteriores requieren evidencia capturada durante la transición.')


def preflight():
    if socket.gethostname().split('.')[0] != CONTROL:
        raise RuntimeError(f'Este evaluador se ejecuta desde {CONTROL}, no desde {socket.gethostname()}.')
    context = kube('config', 'current-context').strip()
    if context != CONTEXT:
        raise RuntimeError(f'Contexto distinto al esperado: {context}. Se requiere {CONTEXT}.')
    if not api_ready():
        raise RuntimeError('API Server no disponible; evaluación NO VERIFICABLE.')


def assess(key, r, *, repeat=False):
    if key in r['etapas'] and not repeat:
        print(f'  {key}: evidencia ya registrada. Se conserva; use --repetir para actualizarla.')
        return False
    # Evitar invalidar las evidencias de UID guardadas por las fases siguientes.
    idx = ORDER.index(key)
    if repeat and any(k in r['etapas'] for k in ORDER[idx+1:]):
        raise RuntimeError('No se puede repetir una etapa después de guardar etapas posteriores; se perdería la correlación.')
    ev = Evaluator()
    PHASES[key](ev, r)
    total = sum(x['puntos'] for x in ev.items)
    if total != WEIGHTS[key]:
        raise RuntimeError(f'Error de ponderación en {key}: {total} != {WEIGHTS[key]}')
    r['etapas'][key] = {'fecha_utc': now(), 'validaciones': ev.items, 'evidencia': ev.evidence}
    save_report(r)
    passed = sum(x['puntos'] for x in ev.items if x['estado'] == 'PASS')
    print(f'\n  Evaluación {key} — {phase_status(r["etapas"][key])} — {passed}/{WEIGHTS[key]} puntos')
    for x in ev.items:
        print(f'    [{x["estado"]}] {x["nombre"]} ({x["puntos"]} pts)')
        if x['estado'] != 'PASS':
            print('       ' + x['detalle'])
    return True


def detect_current(r):
    """Detectar solo un punto verificable sin confundir historial con estado actual."""
    ns = namespace_exists()
    if not ns:
        return '5:final' if '5:restaurado' in r['etapas'] else None
    worker = nodes()[WORKER]
    cordoned = not schedulable(worker)
    if cordoned:
        if '4' in r['etapas'] and '5:drenado' not in r['etapas']:
            return '5:drenado'
        if '2' in r['etapas'] and '3' not in r['etapas']:
            return '3' if app_placement(CONTROL) else None
        if '1' in r['etapas'] and '2' not in r['etapas']:
            try:
                get_json('get', 'pod', 'cordon-test', '-n', NAMESPACE)
                return '2'
            except RuntimeError:
                return None
        return None
    if '5:drenado' in r['etapas'] and '5:restaurado' not in r['etapas']:
        return '5:restaurado'
    if '3' in r['etapas'] and '4' not in r['etapas']:
        return '4'
    # Un estado Ready y con Pods no diferencia T1 de T4 sin evidencia previa.
    # No registrar automáticamente una fase por semejanza con el estado actual.
    return None


def full_evaluation(r):
    """Revisar todas las tareas y capturar únicamente un punto observable sin inventar pasado."""
    print('\nLAB 2 — EVALUACIÓN COMPLETA (ESTADO ACTUAL + EVIDENCIA REGISTRADA)')
    monitor_status()
    key = detect_current(r)
    if key and key not in r['etapas']:
        print(f'  Estado actual compatible con {key}; se evalúa y guarda ese punto.')
        assess(key, r)
    elif key:
        print(f'  Punto actual {key} ya evaluado. No se sobreescribe.')
    else:
        print('  No hay un nuevo punto de control identificable sin ambigüedad.')
        print('  No se asignan puntos por transiciones pasadas que no fueron registradas.')
    print('\n  DIAGNÓSTICO ACTUAL (no suma puntos):')
    ev = Evaluator()
    ev.check('Contexto administrativo', 0, lambda: kube('config','current-context').strip() == CONTEXT)
    ev.check('Nodos Ready y worker2 ausente', 0, lambda: set(nodes()) == {CONTROL,WORKER} and all(ready(n) for n in nodes().values()))
    ev.check('Worker habilitado para scheduling', 0, lambda: schedulable(nodes()[WORKER]))
    ev.check('Namespace lab2 disponible', 0, namespace_exists)
    if namespace_exists():
        ev.check('Deployment con tres réplicas', 0, app_available)
        ev.check('Afinidad, toleration e imagen', 0, lambda: all(app_preferred_worker()))
    else:
        print('    Namespace ausente: puede indicar limpieza final o práctica no iniciada.')
    for item in ev.items:
        print(f'    [{item["estado"]}] {item["nombre"]}')
    show_summary(r)




def probe(key, r):
    """Evaluación temporal no persistente; nunca modifica el clúster."""
    ev = Evaluator()
    PHASES[key](ev, r)
    return ev


def monitor_running():
    try:
        pid = int(PID_FILE.read_text().strip())
        if pid <= 1:
            return None
        os.kill(pid, 0)
        return pid
    except (ValueError, FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def auto_monitor():
    """Captura las siete fases en orden: nunca infiere estados pasados.

    El muestreo no equivale a un registro auditado y puede perder estados breves.
    """
    PID_FILE.write_text(str(os.getpid()), encoding='utf-8')
    print(f'MONITOR LAB 2 ACTIVO — PID {os.getpid()} — intervalo 2 s', flush=True)
    try:
        while True:
            r = load_report()
            key = next((k for k in ORDER if k not in r['etapas']), None)
            if key is None:
                print('Todas las fases capturadas. Monitor finalizado.', flush=True)
                break
            try:
                preflight()
                # Tarea 1 solo se certifica una vez configurado correctamente el lab.
                # En fases posteriores únicamente se registra el snapshot COMPLETO.
                ev = probe(key, r)
                if ev.items and all(x['estado'] == 'PASS' for x in ev.items):
                    r['etapas'][key] = {
                        'fecha_utc': now(), 'validaciones': ev.items,
                        'evidencia': ev.evidence,
                        'metodo_captura': 'monitor_automatico',
                    }
                    save_report(r)
                    print(f'CAPTURADA {key} — {WEIGHTS[key]}/{WEIGHTS[key]} puntos', flush=True)
            except (RuntimeError, ValueError, KeyError, OSError) as exc:
                print(f'AVISO {key}: {str(exc)[:180]}', flush=True)
            time.sleep(2)
    finally:
        try:
            if PID_FILE.exists() and PID_FILE.read_text().strip() == str(os.getpid()):
                PID_FILE.unlink()
        except OSError:
            pass


def start_monitor():
    pid = monitor_running()
    if pid:
        print(f'Monitor ya está activo (PID {pid}).')
        return
    # Sólo permitir inicio si kubectl funciona; evita arrancar y fallar silenciosamente.
    preflight()
    with MONITOR_LOG.open('a', encoding='utf-8') as log:
        child = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), '--monitor-interno'],
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True, cwd=str(REPORT.parent))
    # Reportar PID del proceso creado; sin prometer que ya empezó a recolectar.
    PID_FILE.write_text(str(child.pid), encoding='utf-8')
    print(f'Monitor iniciado (PID {child.pid}); capturará etapas automáticamente cada 2 segundos.')
    print(f'Bitácora: {MONITOR_LOG}')
    print('IMPORTANTE: debe iniciarse ANTES de cordon/drain; no recupera estados anteriores.')


def stop_monitor():
    pid = monitor_running()
    if not pid:
        print('No hay monitor activo.')
        return
    os.kill(pid, signal.SIGTERM)
    print(f'Se solicitó detener el monitor PID {pid}.')


def monitor_status():
    pid = monitor_running()
    print('MONITOR ACTIVO' + f' (PID {pid})' if pid else 'MONITOR DETENIDO')
    print(f'Bitácora: {MONITOR_LOG}')

def main():
    parser = argparse.ArgumentParser(description='CKA Lab 2: evalúa tareas, completo y resumen sin SSH.')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--tarea', type=int, choices=range(1,6), help='Evaluar tarea actual (T5 requiere --punto)')
    group.add_argument('--etapa', type=int, choices=range(1,6), help='Alias compatible con versiones anteriores')
    group.add_argument('--completo', action='store_true', help='Evaluar estado actual sin inventar evidencia histórica y mostrar las 5 tareas')
    group.add_argument('--resumen', action='store_true', help='Mostrar resultados guardados; no realiza nuevas verificaciones')
    group.add_argument('--autoprueba', action='store_true', help='Probar integridad del script sin Kubernetes')
    group.add_argument('--iniciar', action='store_true', help='Iniciar captura automática en segundo plano')
    group.add_argument('--detener', action='store_true', help='Detener captura automática')
    group.add_argument('--estado', action='store_true', help='Mostrar estado del monitor')
    group.add_argument('--monitor-interno', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--punto', choices=['drenado','restaurado','final'], help='Para tarea 5')
    parser.add_argument('--repetir', action='store_true', help='Actualizar tarea anterior mientras no haya etapas posteriores')
    args = parser.parse_args()
    if args.autoprueba:
        assert set(PHASES)==set(WEIGHTS) and sum(WEIGHTS.values())==100
        assert sum(WEIGHTS[k] for k in ORDER[4:]) == 20
        assert all(sum(x['puntos'] for x in snapshot_check(phase)) == WEIGHTS[phase] for phase in ORDER)
        print(f'AUTOPRUEBA OK — v{VERSION}, 5 tareas, 7 puntos, total 100.')
        return 0
    task = args.tarea if args.tarea is not None else args.etapa
    if task == 5 and not args.punto:
        parser.error('Tarea 5 requiere --punto drenado, restaurado o final.')
    if task != 5 and args.punto:
        parser.error('--punto solo se utiliza con --tarea 5.')
    if args.repetir and task is None:
        parser.error('--repetir requiere --tarea N.')
    try:
        if args.monitor_interno:
            auto_monitor()
            return 0
        if args.iniciar:
            start_monitor()
            return 0
        if args.detener:
            stop_monitor()
            return 0
        if args.estado:
            monitor_status()
            return 0
        r = load_report()
        if args.resumen:
            show_summary(r)
            return 0
        preflight()
        if args.completo:
            full_evaluation(r)
            return 0
        key = str(task) if task != 5 else f'5:{args.punto}'
        # No exigimos fases anteriores: evaluar etapa aislada es útil si se comenzó tarde;
        # la comparación de UID dependiente de otra etapa será UNVERIFIED.
        assess(key,r,repeat=args.repetir)
        show_summary(r)
        return 0
    except (RuntimeError, OSError, KeyError, ValueError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 2


def snapshot_check(key):
    """Lista de ponderaciones para autoprueba, sin tocar Kubernetes."""
    class Fake(Evaluator):
        def check(self, name, points, func):
            self.items.append({'puntos':points})
        def evidence_of(self, name, func):
            pass
    ev = Fake()
    PHASES[key](ev, {'etapas': {}})
    return ev.items


if __name__ == '__main__':
    sys.exit(main())
