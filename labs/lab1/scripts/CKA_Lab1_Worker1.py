#!/usr/bin/env python3
"""Lab 1: evaluación local de cka-worker1, sin SSH ni acceso al control plane."""
import argparse
import datetime as dt
import json
import subprocess
from pathlib import Path

CHECKS = []


def run(*argv, timeout=15):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
        return p.returncode == 0, p.stdout.strip(), p.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, '', str(exc)


def record(name, ok, detail='', unverified=False):
    CHECKS.append({'task': 4, 'name': name,
                   'status': 'PASS' if ok else ('UNVERIFIED' if unverified else 'FAIL'),
                   'detail': str(detail)[:400]})


def permission_error(error):
    error = error.lower()
    return any(s in error for s in ('permission denied', 'authentication is required',
                                    'a password is required', 'not in the sudoers',
                                    'sudo: a terminal is required', 'sudo: sorry',
                                    'command not found', 'no such file or directory'))


def check(name, args, predicate=lambda s: bool(s), privileged=False):
    ok, out, err = run(*args, timeout=20)
    if not ok and privileged:
        direct = args[2:] if args[:2] == ('sudo', '-n') else args
        direct_ok, direct_out, direct_err = run(*direct, timeout=20)
        if direct_ok:
            ok, out, err = direct_ok, direct_out, direct_err
    passed = ok and predicate(out)
    record(name, passed, (out or 'Correcto') if passed else (err or out or 'No cumple'),
           unverified=not ok and permission_error(err))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output', default='reporte_lab1_worker1.json')
    args = ap.parse_args()
    check('Hostname worker1', ('hostname',), lambda x: x == 'cka-worker1')
    check('kubelet activo', ('systemctl', 'is-active', 'kubelet'), lambda x: x == 'active')
    check('containerd activo', ('systemctl', 'is-active', 'containerd'), lambda x: x == 'active')
    check('Logs de kubelet accesibles', ('sudo', '-n', 'journalctl', '-u', 'kubelet', '-n', '20', '--no-pager'),
          lambda x: bool(x) and ('kubelet' in x.lower() or bool(x.strip())), privileged=True)
    check('CRI: contenedor calico-node', ('sudo', '-n', 'crictl', 'ps'),
          lambda x: 'calico-node' in x, privileged=True)
    check('CRI: sandbox kube-proxy', ('sudo', '-n', 'crictl', 'pods'),
          lambda x: 'kube-proxy' in x, privileged=True)
    check('Archivo config.yaml de kubelet', ('sudo', '-n', 'test', '-f', '/var/lib/kubelet/config.yaml'),
          lambda _: True, privileged=True)
    static_components = ('etcd', 'kube-apiserver', 'kube-controller-manager', 'kube-scheduler')
    # Sin shell: consultas de presencia de archivos, sin escribir nada.
    # Para validar ausencia de todos, la lectura del directorio debe ser posible.
    ok, out, err = run('sudo', '-n', 'ls', '-1', '/etc/kubernetes/manifests/')
    if not ok:
        direct_ok, direct_out, direct_err = run('ls', '-1', '/etc/kubernetes/manifests/')
        if direct_ok:
            ok, out, err = direct_ok, direct_out, direct_err
    if ok:
        found = [f'{name}.yaml' for name in static_components if f'{name}.yaml' in out.splitlines()]
        record('Sin static Pods del control plane', not found, found if found else 'No existen manifiestos del control plane')
    elif 'no such file or directory' in err.lower():
        record('Sin static Pods del control plane', True, 'El directorio manifests no existe')
    else:
        record('Sin static Pods del control plane', False, err,
               unverified=permission_error(err))

    passed = sum(x['status'] == 'PASS' for x in CHECKS)
    unverified = sum(x['status'] == 'UNVERIFIED' for x in CHECKS)
    score = round(20 * passed / len(CHECKS), 2)
    report = {'lab': 'lab1', 'node': 'cka-worker1', 'type': 'estado_observable_no_ejecucion',
              'timestamp': dt.datetime.now(dt.timezone.utc).isoformat(),
              'score': score, 'max_score': 20, 'percentage': round(score / 20 * 100, 2),
              'provisional': unverified > 0, 'unverified': unverified,
              'summary': [{'task': 4, 'label': 'Worker y runtime', 'weight': 20,
                           'points': score, 'passed': passed, 'unverified': unverified,
                           'total': len(CHECKS)}], 'checks': CHECKS,
              'note': 'La evaluación observa el estado, no demuestra qué comandos ejecutó el alumno.'}
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('\nLAB 1 — EVALUACIÓN LOCAL DE CKA-WORKER1 (sin SSH)')
    print(f'Tarea 4: {score:.2f}/20 puntos | PASS {passed}/{len(CHECKS)} | UNVERIFIED {unverified}')
    print(f"RESULTADO WORKER1: {score:.2f}/20 puntos = {report['percentage']:.2f}%" +
          (' (PROVISIONAL: faltan permisos/evidencias)' if unverified else ''))
    print('Reporte:', args.output)
    for c in CHECKS:
        if c['status'] != 'PASS':
            print(f"  [{c['status']}] {c['name']}: {c['detail']}")


if __name__ == '__main__':
    main()
