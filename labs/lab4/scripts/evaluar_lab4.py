#!/usr/bin/env python3
"""Evaluador de Lab 4 (RBAC). Solo lectura, monitor local y evidencias acumulativas.

Uso: python3 evaluar_lab4.py --iniciar|--estado|--tarea N|--completo|--resumen|--detener
Ejecutar en el mismo equipo donde se usa kubectl y se crea workspace/lab4.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any

VERSION = "1.0.0"
NAMESPACE = "lab4"
SA = "system:serviceaccount:lab4:lab4-operator"
SUPPORT = "system:serviceaccount:lab4:support-agent"
AUDIT = "system:serviceaccount:lab4:audit-reader"
REPORT_NAME = "reporte_lab4.json"
PID_NAME = ".evaluar_lab4_monitor.pid"
LOG_NAME = ".evaluar_lab4_monitor.log"
MAX_AGE_SECONDS = 120

TASK_NAMES = {
    1: "Preparación del escenario",
    2: "Identidad técnica",
    3: "Role de lectura",
    4: "RoleBinding y permisos",
    5: "Kubeconfig temporal",
    6: "Lectura de nodos",
    7: "Reto: corregir RBAC",
    8: "Reto: auditor y limpieza",
}
# id, tarea, puntos, descripción. La suma por tarea es 10,10,12,14,14,12,14,14.
CHECKS = [
    ("context", 1, 2, "Contexto kubectl disponible"),
    ("nodes_ready", 1, 2, "Tres nodos Ready"),
    ("namespace", 1, 2, "Namespace lab4"),
    ("web", 1, 4, "Deployment web, nginx, 2 réplicas"),
    ("operator_sa", 2, 4, "ServiceAccount lab4-operator"),
    ("operator_initial_no_pods", 2, 3, "Sin permiso inicial para listar Pods"),
    ("operator_initial_no_nodes", 2, 3, "Sin permiso inicial para listar nodos"),
    ("role", 3, 8, "Role workload-reader de solo lectura"),
    ("operator_no_create", 3, 4, "No puede crear Pods"),
    ("rolebinding", 4, 5, "RoleBinding vincula la identidad"),
    ("operator_list_pods", 4, 3, "Puede listar Pods en lab4"),
    ("operator_get_deploy", 4, 2, "Puede consultar Deployments en lab4"),
    ("operator_no_delete", 4, 2, "No puede eliminar Pods"),
    ("operator_no_other_ns", 4, 2, "No puede listar Pods en kube-system"),
    ("kubeconfig_structure", 5, 4, "Kubeconfig aislado y contexto lab4-operator"),
    ("kubeconfig_token", 5, 3, "Credencial temporal configurada"),
    ("kubeconfig_list", 5, 4, "Acceso real a Pods con kubeconfig"),
    ("kubeconfig_no_nodes", 5, 3, "Acceso real a nodos denegado antes de ClusterRole"),
    ("clusterrole", 6, 4, "ClusterRole de lectura mínima de nodos"),
    ("clusterrolebinding", 6, 3, "ClusterRoleBinding correcto"),
    ("operator_nodes", 6, 3, "Puede consultar nodos"),
    ("operator_nodes_no_delete", 6, 2, "No puede eliminar nodos"),
    ("support_setup", 7, 2, "ServiceAccount y ConfigMap de soporte"),
    ("support_role", 7, 3, "Role configmap-reader mínimo"),
    ("support_binding", 7, 5, "RoleBinding reparado correctamente"),
    ("support_get", 7, 2, "support-agent puede leer ConfigMaps"),
    ("support_no_delete", 7, 2, "support-agent no puede eliminar ConfigMaps"),
    ("audit_sa", 8, 1, "ServiceAccount audit-reader"),
    ("audit_policy", 8, 5, "Role/RoleBinding de auditor sin permisos excesivos"),
    ("audit_reads", 8, 2, "Auditor puede leer Pods y Deployments"),
    ("audit_denies", 8, 2, "Auditor no puede escribir, leer Secrets ni salir de lab4"),
    ("cleanup", 8, 4, "Limpieza final sin eliminar la infraestructura base"),
]
TOTAL = sum(x[2] for x in CHECKS)
assert TOTAL == 100
assert {t: sum(p for _, task, p, _ in CHECKS if task == t) for t in range(1, 9)} == {1:10,2:10,3:12,4:14,5:14,6:12,7:14,8:14}


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def run(args: list[str], timeout: int = 9, truncate: bool = True) -> tuple[bool, str]:
    try:
        p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, stdin=subprocess.DEVNULL)
        s = (p.stdout if p.returncode == 0 else p.stderr or p.stdout).strip()
        return p.returncode == 0, s[:2500] if truncate else s
    except FileNotFoundError:
        return False, f"No se encontró {args[0]} en PATH"
    except subprocess.TimeoutExpired:
        return False, "Tiempo de espera agotado"
    except OSError as exc:
        return False, str(exc)


def kubectl(*args: str, timeout: int = 9) -> tuple[bool, str]:
    return run(["kubectl", "--request-timeout=6s", *args], timeout=timeout)


def get_obj(*args: str) -> tuple[dict | None, str]:
    ok, out = run(["kubectl", "--request-timeout=6s", "get", *args, "-o", "json"], truncate=False)
    if not ok:
        return None, out
    try:
        value = json.loads(out)
        return value if isinstance(value, dict) else None, ""
    except json.JSONDecodeError:
        return None, "Respuesta JSON no válida de kubectl"


def auth(verb: str, resource: str, identity: str, namespace: str | None = None) -> tuple[bool | None, str]:
    args = ["auth", "can-i", verb, resource, "--as=" + identity]
    if namespace is not None:
        args.extend(["-n", namespace])
    ok, out = kubectl(*args)
    if out.strip().lower() == "yes":
        return True, ""
    if out.strip().lower() == "no":
        return False, ""
    return None, out


def rules_exact(obj: dict | None, expected: dict[tuple[str,str], set[str]]) -> bool:
    if obj is None:
        return False
    got: dict[tuple[str,str], set[str]] = {}
    for rule in obj.get("rules", []):
        # RBAC con resourceNames o nonResourceURLs no equivale a esta práctica.
        if rule.get("resourceNames") or rule.get("nonResourceURLs"):
            return False
        for group in rule.get("apiGroups", []):
            for resource in rule.get("resources", []):
                got.setdefault((group, resource), set()).update(rule.get("verbs", []))
    return got == expected


def binding_to(obj: dict | None, kind: str, role: str, sa_name: str) -> bool:
    if obj is None:
        return False
    ref = obj.get("roleRef", {})
    if ref.get("kind") != kind or ref.get("name") != role:
        return False
    subs = obj.get("subjects", [])
    return len(subs) == 1 and subs[0].get("kind") == "ServiceAccount" and subs[0].get("name") == sa_name and subs[0].get("namespace") == NAMESPACE


def workspace_candidates(user_path: str | None) -> list[Path]:
    if user_path:
        p = Path(user_path).expanduser()
        return [p / "lab4-operator.kubeconfig", p / "workspace" / "lab4" / "lab4-operator.kubeconfig"]
    home = Path.home()
    cwd = Path.cwd()
    paths = [cwd / "lab4-operator.kubeconfig", cwd / "workspace" / "lab4" / "lab4-operator.kubeconfig", home / "cka-labs" / "workspace" / "lab4" / "lab4-operator.kubeconfig"]
    for parent in list(cwd.parents)[:5]:
        paths.append(parent / "workspace" / "lab4" / "lab4-operator.kubeconfig")
    return paths


def kubeconfig_path(user_path: str | None) -> Path | None:
    return next((p for p in workspace_candidates(user_path) if p.is_file()), None)


def collect(existing: dict, workspace: str | None) -> dict[str, tuple[str, str]]:
    """No modifica objetos ni imprime credenciales. Guarda solo estados y mensajes breves seguros."""
    outcomes: dict[str, tuple[str, str]] = {}
    def put(cid: str, result: bool | None, detail: str = "") -> None:
        outcomes[cid] = ("PASS" if result is True else "FAIL" if result is False else "UNVERIFIED", detail[:180])
    ok, context = kubectl("config", "current-context")
    put("context", ok and bool(context), "" if ok else context)
    nodes, err = get_obj("nodes")
    if nodes is None:
        put("nodes_ready", None, err)
    else:
        ready_names = {n.get("metadata", {}).get("name") for n in nodes.get("items", []) if any(c.get("type") == "Ready" and c.get("status") == "True" for c in n.get("status", {}).get("conditions", []))}
        put("nodes_ready", {"cka-control", "cka-worker1", "cka-worker2"}.issubset(ready_names))
    ns, e = get_obj("namespace", NAMESPACE)
    put("namespace", ns is not None if ns or "NotFound" in e or "not found" in e else None, "" if ns else e)
    if ns is not None:
        dep, _ = get_obj("deployment", "web", "-n", NAMESPACE)
        sa_operator, _ = get_obj("serviceaccount", "lab4-operator", "-n", NAMESPACE)
        role, _ = get_obj("role", "workload-reader", "-n", NAMESPACE)
        rb, _ = get_obj("rolebinding", "lab4-operator-reader", "-n", NAMESPACE)
        support_sa, _ = get_obj("serviceaccount", "support-agent", "-n", NAMESPACE)
        cm, _ = get_obj("configmap", "app-settings", "-n", NAMESPACE)
        support_role, _ = get_obj("role", "configmap-reader", "-n", NAMESPACE)
        support_binding, _ = get_obj("rolebinding", "support-configmap-reader", "-n", NAMESPACE)
        audit_sa, _ = get_obj("serviceaccount", "audit-reader", "-n", NAMESPACE)
        roles, _ = get_obj("roles", "-n", NAMESPACE)
        bindings, _ = get_obj("rolebindings", "-n", NAMESPACE)
    else:
        dep = sa_operator = role = rb = support_sa = cm = support_role = support_binding = audit_sa = roles = bindings = None
    good_dep = bool(dep and dep.get("spec", {}).get("replicas") == 2 and dep.get("status", {}).get("availableReplicas", 0) >= 2 and any(c.get("image") == "nginx:1.29-alpine" for c in dep.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])))
    put("web", good_dep)
    put("operator_sa", sa_operator is not None)
    role_valid = rules_exact(role, {("", "pods"): {"get", "list", "watch"}, ("apps", "deployments"): {"get", "list", "watch"}})
    put("role", role_valid)
    put("rolebinding", binding_to(rb, "Role", "workload-reader", "lab4-operator"))
    clusterrole, _ = get_obj("clusterrole", "lab4-node-reader")
    clrb, _ = get_obj("clusterrolebinding", "lab4-operator-node-reader")
    put("clusterrole", rules_exact(clusterrole, {("", "nodes"): {"get", "list"}}))
    put("clusterrolebinding", binding_to(clrb, "ClusterRole", "lab4-node-reader", "lab4-operator"))
    put("support_setup", support_sa is not None and cm is not None and cm.get("data", {}).get("environment") == "training")
    put("support_role", rules_exact(support_role, {("", "configmaps"): {"get", "list"}}))
    put("support_binding", binding_to(support_binding, "Role", "configmap-reader", "support-agent"))
    put("audit_sa", audit_sa is not None)
    # Permitimos nombres alternativos para Role y RoleBinding de la tarea sin comandos prescritos.
    audit_roles = {r.get("metadata", {}).get("name"): r for r in (roles or {}).get("items", []) if rules_exact(r, {("", "pods"): {"get", "list"}, ("apps", "deployments"): {"get", "list"}})}
    audit_bindings = [b for b in (bindings or {}).get("items", []) if b.get("roleRef", {}).get("kind") == "Role" and b.get("roleRef", {}).get("name") in audit_roles and binding_to(b, "Role", b.get("roleRef", {}).get("name", ""), "audit-reader")]
    # El auditor no debe tener ClusterRoleBinding de ningún tipo.
    all_clrb, _ = get_obj("clusterrolebindings")
    audit_global = any(any(s.get("kind") == "ServiceAccount" and s.get("name") == "audit-reader" and s.get("namespace") == NAMESPACE for s in b.get("subjects", [])) for b in (all_clrb or {}).get("items", []))
    put("audit_policy", bool(audit_roles and audit_bindings and not audit_global))
    auth_checks = [
        ("operator_initial_no_pods", "list", "pods", SA, NAMESPACE, False),
        ("operator_initial_no_nodes", "list", "nodes", SA, None, False),
        ("operator_no_create", "create", "pods", SA, NAMESPACE, False),
        ("operator_list_pods", "list", "pods", SA, NAMESPACE, True),
        ("operator_get_deploy", "get", "deployments.apps", SA, NAMESPACE, True),
        ("operator_no_delete", "delete", "pods", SA, NAMESPACE, False),
        ("operator_no_other_ns", "list", "pods", SA, "kube-system", False),
        ("operator_nodes", "list", "nodes", SA, None, True),
        ("operator_nodes_no_delete", "delete", "nodes", SA, None, False),
        ("support_get", "get", "configmaps", SUPPORT, NAMESPACE, True),
        ("support_no_delete", "delete", "configmaps", SUPPORT, NAMESPACE, False),
    ]
    prerequisites = {
        "operator_initial_no_pods": sa_operator is not None,
        "operator_initial_no_nodes": sa_operator is not None,
        "operator_no_create": role_valid,
        "operator_list_pods": rb is not None,
        "operator_get_deploy": rb is not None,
        "operator_no_delete": rb is not None,
        "operator_no_other_ns": rb is not None,
        "operator_nodes": clrb is not None,
        "operator_nodes_no_delete": clrb is not None,
        "support_get": support_binding is not None,
        "support_no_delete": support_binding is not None,
    }
    for cid, verb, resource, identity, scope, expected in auth_checks:
        if not prerequisites[cid]:
            put(cid, False, "Falta el recurso de la etapa")
            continue
        val, reason = auth(verb, resource, identity, scope)
        put(cid, None if val is None else val == expected, reason)
    v1, e1 = auth("list", "pods", AUDIT, NAMESPACE)
    v2, e2 = auth("get", "deployments.apps", AUDIT, NAMESPACE)
    put("audit_reads", None if v1 is None or v2 is None else bool(audit_bindings) and v1 and v2, e1 or e2)
    denies = [auth(verb, resource, AUDIT, scope) for verb, resource, scope in [("create", "pods", NAMESPACE), ("delete", "pods", NAMESPACE), ("get", "secrets", NAMESPACE), ("list", "pods", "kube-system"), ("create", "deployments.apps", NAMESPACE), ("delete", "deployments.apps", NAMESPACE)]]
    put("audit_denies", None if any(x[0] is None for x in denies) else bool(audit_bindings) and all(x[0] is False for x in denies), next((x[1] for x in denies if x[1]), ""))
    path = kubeconfig_path(workspace)
    if path is None:
        put("kubeconfig_structure", False, "No se encontró lab4-operator.kubeconfig; use --workspace RUTA")
        put("kubeconfig_token", False)
        put("kubeconfig_list", False)
        put("kubeconfig_no_nodes", False)
    else:
        # No reportar token o kubeconfig completo ni capturar salida de config view --raw.
        good, raw = run(["kubectl", "config", "view", "--kubeconfig", str(path), "--raw", "-o", "json"], truncate=False)
        cfg = None
        if good:
            try:
                cfg = json.loads(raw)
            except json.JSONDecodeError:
                pass
        contexts = [c.get("context", {}) for c in (cfg or {}).get("contexts", []) if c.get("name") == "lab4-operator"]
        users = {u.get("name"): u.get("user", {}) for u in (cfg or {}).get("users", [])}
        context_ok = bool(contexts and contexts[0].get("namespace") == NAMESPACE and contexts[0].get("user") == "lab4-operator")
        put("kubeconfig_structure", context_ok, "" if context_ok else "Contexto o namespace incorrecto")
        put("kubeconfig_token", bool(users.get("lab4-operator", {}).get("token")), "" if good else "Kubeconfig no legible")
        # Consultas reales: nunca almacenar respuestas que pudieran contener secretos.
        kbase = ["kubectl", "--request-timeout=6s", "--kubeconfig=" + str(path), "--context=lab4-operator"]
        kpass, _ = run(kbase + ["get", "pods", "-n", NAMESPACE, "-o", "name"])
        put("kubeconfig_list", kpass)
        knodes, kout = run(kbase + ["get", "nodes", "-o", "name"])
        # Solo se acredita denegación de autorización, no errores de red / token vencido.
        put("kubeconfig_no_nodes", context_ok and bool(users.get("lab4-operator", {}).get("token")) and not knodes and ("Forbidden" in kout or "forbidden" in kout), "" if not knodes and "forbidden" in kout.lower() else "No se confirmó respuesta Forbidden")
    # No puntuar limpieza si nunca se acreditó la política de auditor y de nodos.
    history = existing.get("aprobadas", {})
    prior_audit = history.get("audit_policy") is not None or outcomes.get("audit_policy", (None,))[0] == "PASS"
    prior_nodes = history.get("clusterrolebinding") is not None or outcomes.get("clusterrolebinding", (None,))[0] == "PASS"
    if prior_audit and prior_nodes and ns is None and clusterrole is None and clrb is None and nodes is not None and len(nodes.get("items", [])) >= 3:
        put("cleanup", True)
    else:
        put("cleanup", False, "Debe capturarse la política antes de eliminar recursos")
    return outcomes


def report_path(base: Path) -> Path:
    return base / REPORT_NAME


def load(base: Path) -> dict:
    p = report_path(base)
    if not p.exists():
        return {"version": VERSION, "lab": "lab4", "creado": now(), "aprobadas": {}, "ultimas": {}, "monitoreo": {}}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(d.get("aprobadas"), dict):
            raise ValueError("formato incompatible")
        return d
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(f"ERROR: el reporte existente no se puede leer ({exc}); no se sobrescribió")


def save(base: Path, data: dict) -> None:
    p = report_path(base)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, p)


def evaluate(base: Path, workspace: str | None, tasks: set[int] | None = None, quiet: bool = False) -> dict:
    data = load(base)
    outcomes = collect(data, workspace)
    for cid, task, points, label in CHECKS:
        if tasks is not None and task not in tasks:
            continue
        status, detail = outcomes[cid]
        data["ultimas"][cid] = {"estado": status, "detalle": detail, "fecha": now()}
        if status == "PASS" and cid not in data["aprobadas"]:
            data["aprobadas"][cid] = {"fecha": now(), "puntos": points}
    data["actualizado"] = now()
    data["version"] = VERSION
    save(base, data)
    if not quiet:
        print_summary(data, tasks)
    return data


def print_summary(d: dict, only: set[int] | None = None) -> None:
    print("\nLAB 4 — EVALUACIÓN RBAC (EVIDENCIAS ACUMULADAS)")
    total = 0
    for t, name in TASK_NAMES.items():
        checks = [x for x in CHECKS if x[1] == t]
        maxp = sum(x[2] for x in checks)
        earned = sum(p for cid, _, p, _ in checks if cid in d.get("aprobadas", {}))
        total += earned
        observed = [cid for cid, _, _, _ in checks if cid in d.get("ultimas", {})]
        if earned == maxp:
            status = "COMPLETADA"
        elif not observed and not earned:
            status = "NO EVALUADA"
        elif earned:
            status = "EN PROGRESO"
        else:
            status = "INCOMPLETA / SIN EVIDENCIA"
        print(f"  Tarea {t}: {status:<27} {earned:>2}/{maxp} pts  | {name}")
        if only is not None and t in only:
            for cid, _, p, label in checks:
                state = "PASS" if cid in d.get("aprobadas", {}) else d.get("ultimas", {}).get(cid, {}).get("estado", "SIN CAPTURA")
                reason = d.get("ultimas", {}).get(cid, {}).get("detalle", "") if state != "PASS" else ""
                print(f"    [{state}] {label} ({p} pts){' — '+reason if reason else ''}")
    print(f"  PUNTOS ACREDITADOS: {total}/100")
    print("  ESTADO: " + ("COMPLETADA" if total == 100 else "PROVISIONAL; no es nota final si falta evidencia"))
    print("  Nota: NO EVALUADA significa que no hay captura, no que el alumno no haya trabajado.")
    print("  La prueba de unset LAB4_TOKEN es manual y no se califica automáticamente.")


def pid_file(base: Path) -> Path:
    return base / PID_NAME


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        return False


def read_pid(base: Path) -> int | None:
    try:
        return int(pid_file(base).read_text().strip())
    except (OSError, ValueError):
        return None


def start(base: Path, workspace: str | None, interval: int) -> None:
    old = read_pid(base)
    if old and pid_alive(old):
        print(f"Monitor ya iniciado (PID {old}).")
        return
    cmd = [sys.executable, str(Path(__file__).resolve()), "--_monitor", "--directorio", str(base), "--intervalo", str(interval)]
    if workspace:
        cmd += ["--workspace", workspace]
    flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "DETACHED_PROCESS", 0) if os.name == "nt" else 0
    with (base / LOG_NAME).open("a", encoding="utf-8") as log:
        p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, cwd=Path.cwd(), start_new_session=(os.name != "nt"), creationflags=flags)
    pid_file(base).write_text(str(p.pid), encoding="utf-8")
    data = load(base)
    data["monitoreo"] = {"inicio": now(), "pid": p.pid, "intervalo_segundos": interval}
    save(base, data)
    print(f"Monitor iniciado (PID {p.pid}). Continúa con la práctica. Evidencia: {report_path(base)}")


def stop(base: Path) -> None:
    pid = read_pid(base)
    if not pid or not pid_alive(pid):
        print("Monitor no está activo.")
        return
    # El monitor sale cuando se elimina su PID file; evita matar procesos con PID reciclado.
    pid_file(base).unlink(missing_ok=True)
    print("Se solicitó detener el monitor. Los resultados permanecen guardados.")


def monitor(base: Path, workspace: str | None, interval: int) -> None:
    own_pid = os.getpid()
    while True:
        if read_pid(base) != own_pid:
            break
        try:
            evaluate(base, workspace, quiet=True)
        except Exception as exc:
            print(f"{now()} Error de monitoreo: {type(exc).__name__}: {exc}", flush=True)
        for _ in range(max(1, interval)):
            if read_pid(base) != own_pid:
                return
            time.sleep(1)


def main() -> None:
    ap = argparse.ArgumentParser(description="Evaluación Lab 4 — RBAC, sin modificaciones al clúster")
    group = ap.add_mutually_exclusive_group(required=True)
    for option in ["iniciar", "estado", "completo", "resumen", "detener", "autoprueba", "_monitor"]:
        group.add_argument("--" + option, action="store_true")
    group.add_argument("--tarea", type=int, choices=range(1, 9), metavar="{1..8}")
    ap.add_argument("--workspace", help="Ruta a workspace/lab4 o a su directorio padre")
    ap.add_argument("--directorio", default=None, help="Carpeta de reportes (por defecto, carpeta del script)")
    ap.add_argument("--intervalo", type=int, default=5, help="Segundos de pausa entre rondas del monitor (predeterminado: 5)")
    a = ap.parse_args()
    base = Path(a.directorio).expanduser().resolve() if a.directorio else Path(__file__).resolve().parent
    if a.autoprueba:
        print(f"AUTOPRUEBA OK — Lab 4 v{VERSION}, 8 tareas, {len(CHECKS)} verificaciones, {TOTAL} puntos")
        return
    if a._monitor:
        monitor(base, a.workspace, a.intervalo)
        return
    if a.iniciar:
        start(base, a.workspace, a.intervalo)
    elif a.estado:
        pid = read_pid(base)
        d = load(base)
        active = bool(pid and pid_alive(pid))
        print("MONITOR: " + ("ACTIVO" if active else "DETENIDO"))
        print("Última captura: " + d.get("actualizado", "ninguna"))
        print("Reporte: " + str(report_path(base)))
    elif a.detener:
        stop(base)
    elif a.resumen:
        print_summary(load(base))
    elif a.completo:
        print("Evaluación completa: captura del estado observable y combinación con evidencias anteriores.")
        evaluate(base, a.workspace)
    elif a.tarea:
        evaluate(base, a.workspace, {a.tarea})

if __name__ == "__main__":
    main()
