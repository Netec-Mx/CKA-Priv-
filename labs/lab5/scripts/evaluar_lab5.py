#!/usr/bin/env python3
"""CKA-Priv · Lab 5 · Evaluador de backup y restore de etcd.

Solo lectura. Se ejecuta LOCALMENTE en cka-control con sudo.
  sudo python3 evaluar_lab5.py --iniciar
  sudo python3 evaluar_lab5.py --estado
  sudo python3 evaluar_lab5.py --tarea 5
  sudo python3 evaluar_lab5.py --completo
  sudo python3 evaluar_lab5.py --resumen
  sudo python3 evaluar_lab5.py --detener
  sudo python3 evaluar_lab5.py --autoprueba

IMPORTANTE: iniciar ANTES de la Tarea 1. El evaluador NO restaura etcd ni
modifica Kubernetes. Los puntos de estados transitorios requieren que el monitor
los observe; el estado final por sí solo no demuestra que hubo un restore.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid

VERSION = "1.0.0"
INTERVAL = 5
REPORT = Path("reporte_lab5.json")
PIDFILE = Path(".evaluar_lab5_monitor.pid")
LOGFILE = Path(".evaluar_lab5_monitor.log")
BACKUP = Path("/opt/cka-backups")
SNAP = BACKUP / "etcd-lab5.db"
ORIGINAL = BACKUP / "etcd-lab5-original.db"
STATUS = BACKUP / "etcd-lab5-status.json"
STAMP = BACKUP / "etcd-lab5.timestamp"
MANIFEST_BACKUP = BACKUP / "etcd.yaml.before-restore"
ETCD_MANIFEST = Path("/etc/kubernetes/manifests/etcd.yaml")
DATA_RESTORE = Path("/var/lib/etcd-restore")
CERTS = [
    "/etc/kubernetes/pki/etcd/ca.crt",
    "/etc/kubernetes/pki/etcd/healthcheck-client.crt",
    "/etc/kubernetes/pki/etcd/healthcheck-client.key",
]
TASKS = {
    1: ("Identificar etcd y marcador anterior", 10),
    2: ("Herramientas, TLS y backups", 10),
    3: ("Creación e integridad del snapshot", 15),
    4: ("Validación del snapshot", 10),
    5: ("Estado posterior al snapshot", 10),
    6: ("Preparación de la restauración", 10),
    7: ("Restauración y etcd operativo", 20),
    8: ("Recuperación del clúster", 10),
    9: ("Consistencia y cierre", 5),
}
# id, tarea, puntos, etiqueta
CHECKS = [
    ("nodes_initial", 1, 2, "Los tres nodos están Ready"),
    ("etcd_manifest", 1, 2, "Static Pod de etcd configurado"),
    ("etcd_pod_initial", 1, 2, "Pod etcd operativo"),
    ("before_initial", 1, 4, "Marcador original before-snapshot"),
    ("binaries", 2, 2, "etcdctl y etcdutl disponibles"),
    ("certificates", 2, 3, "Certificados TLS accesibles"),
    ("health_pre", 2, 3, "etcd saludable antes del restore"),
    ("backup_dir", 2, 2, "Ruta de backups preparada"),
    ("snapshot", 3, 5, "Snapshot creado después del inicio del monitor"),
    ("snapshot_metadata", 3, 3, "Snapshot válido según etcdutl"),
    ("snapshot_duplicate", 3, 5, "Copia idéntica del snapshot (SHA-256)"),
    ("snapshot_timestamp", 3, 2, "Registro de fecha del backup"),
    ("snapshot_status", 4, 5, "Metadata legible (hash, revision, claves)"),
    ("snapshot_json", 4, 2, "Status JSON guardado y válido"),
    ("before_presnapshot", 4, 3, "Marcador inicial disponible antes del restore"),
    ("after_namespace", 5, 3, "Namespace etcd-after creado después del snapshot"),
    ("after_marker", 5, 5, "Marcador after-snapshot observado antes del restore"),
    ("both_markers", 5, 2, "Dos marcadores presentes simultáneamente"),
    ("manifest_copy", 6, 5, "Backup del manifiesto original"),
    ("active_data", 6, 2, "Directorio original de datos conservado"),
    ("restore_dir_fresh", 6, 3, "Destino de restore libre antes de usarlo"),
    ("restore_structure", 7, 5, "Datos restaurados: member/snap y member/wal"),
    ("restored_hostpath", 7, 8, "Static Pod usa hostPath restaurado"),
    ("etcd_health_restored", 7, 4, "etcd saludable usando el directorio restaurado"),
    ("container_datadir", 7, 3, "--data-dir interno conserva /var/lib/etcd"),
    ("api_ready", 8, 2, "API Server recuperado"),
    ("nodes_final", 8, 2, "Tres nodos Ready tras el restore"),
    ("before_restored", 8, 3, "Marcador before-snapshot recuperado"),
    ("after_absent", 8, 3, "Marcador after-snapshot desapareció tras restaurar"),
    ("cleanup", 9, 2, "Namespace temporal etcd-before eliminado"),
    ("backups_retained", 9, 2, "Backups y evidencia conservados"),
    ("manifest_final", 9, 1, "etcd sigue usando datos restaurados"),
]
CHECK_BY_ID = {x[0]: x for x in CHECKS}


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def cmd(args, timeout=5):
    """(exit_code, stdout, stderr) separados. Sin truncar JSON."""
    try:
        p = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except FileNotFoundError:
        return 127, "", f"Falta ejecutable: {args[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", "Timeout"
    except OSError as exc:
        return 126, "", str(exc)


def pass_(detail=""):
    return "PASS", detail


def fail(detail):
    return "FAIL", detail


def unknown(detail):
    return "UNVERIFIED", detail


def file_text(path):
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except (OSError, PermissionError):
        return None


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_hostpath(manifest):
    """Extrae el hostPath del volumen etcd-data, no un match casual del texto."""
    if not manifest:
        return None
    lines = manifest.splitlines()
    for i, line in enumerate(lines):
        if not re.match(r"^\s*name:\s*etcd-data\s*$", line):
            continue
        # kubeadm pone '- hostPath:' antes de 'name: etcd-data' en volumes.
        near = "\n".join(lines[max(0, i-5):i+1])
        m = re.search(r"hostPath:\s*\n(?:\s+.*\n)*?\s*path:\s*([^\s#]+)", near)
        if m:
            return m.group(1)
    return None


def kubeconfig_path():
    env = os.environ.get("KUBECONFIG", "")
    for raw in env.split(os.pathsep):
        if raw and Path(raw).is_file():
            return raw
    sudo_user = os.environ.get("SUDO_USER", "")
    candidates = []
    if sudo_user and sudo_user != "root":
        candidates.append(Path("/home") / sudo_user / ".kube/config")
    candidates += [Path("/home/control/.kube/config"), Path("/etc/kubernetes/admin.conf"), Path.home()/".kube/config"]
    for p in candidates:
        if p.is_file():
            return str(p)
    return None


class Inspector:
    def __init__(self, report):
        self.report = report
        self.cache = {}
        self.kconf = kubeconfig_path()
        self.manifest = file_text(ETCD_MANIFEST)

    def run(self, key, args, timeout=5):
        if key not in self.cache:
            self.cache[key] = cmd(args, timeout)
        return self.cache[key]

    def kubectl(self, *args):
        if not self.kconf:
            return 127, "", "Kubeconfig no localizado"
        return self.run(("kubectl", args), ["kubectl", "--kubeconfig", self.kconf,
                                             "--request-timeout=4s", *args], 6)

    def obj(self, kind, name=None, namespace=None):
        args = ["get", kind]
        if name:
            args.append(name)
        if namespace:
            args += ["-n", namespace]
        rc, out, err = self.kubectl(*args, "-o", "json")
        if rc:
            if re.search(r"(?i)(notfound|not found)", err):
                return "ABSENT", None
            return "ERROR", err or out or "kubectl no disponible"
        try:
            return "OK", json.loads(out)
        except ValueError:
            return "ERROR", "JSON inválido de kubectl (no truncado)"

    def nodes(self):
        s, o = self.obj("nodes")
        if s != "OK":
            return unknown(str(o))
        rows = {x.get("metadata", {}).get("name"): x for x in o.get("items", [])}
        expected = {"cka-control", "cka-worker1", "cka-worker2"}
        if not expected.issubset(rows):
            return fail("Faltan nodos esperados")
        for n in expected:
            if rows[n].get("spec", {}).get("unschedulable"):
                return fail(n + " está cordoned")
            conditions = rows[n].get("status", {}).get("conditions", [])
            if not any(c.get("type") == "Ready" and c.get("status") == "True" for c in conditions):
                return fail(n + " no está Ready")
        return pass_()

    def marker(self, ns, expected):
        s, o = self.obj("configmap", "recovery-marker", ns)
        if s == "ERROR":
            return unknown(o)
        if s == "ABSENT":
            return fail("No existe ConfigMap en " + ns)
        return pass_() if o.get("data", {}).get("state") == expected else fail("Valor de marcador inesperado")

    def namespace(self, ns):
        s, o = self.obj("namespace", ns)
        if s == "ERROR":
            return unknown(o)
        return pass_() if s == "OK" and o.get("status", {}).get("phase") == "Active" else fail(ns + " no está activo")

    def health(self, phase="pre"):
        c = ["etcdctl", "--endpoints=https://127.0.0.1:2379",
             "--cacert=" + CERTS[0], "--cert=" + CERTS[1], "--key=" + CERTS[2], "endpoint", "health"]
        rc, out, err = self.run("health:" + phase, c, 6)
        if rc:
            return unknown("etcd todavía no responde: " + (err or "sin respuesta")[:140])
        if re.search(r"health(y)?|successfully committed|is healthy", out, re.I):
            return pass_()
        return unknown("No se pudo confirmar salud")

    def snapshot_info(self):
        if not SNAP.is_file():
            return "ABSENT", None
        rc, out, err = self.run("snapshot_info", ["etcdutl", "snapshot", "status", str(SNAP), "--write-out=json"], 12)
        if rc:
            return "ERROR", (err or out)[:180]
        try:
            data = json.loads(out)
            if not isinstance(data, dict):
                return "ERROR", "Snapshot status inesperado"
            return "OK", data
        except ValueError:
            return "ERROR", "etcdutl no devolvió JSON válido"

    def valid_snapshot_info(self):
        state, data = self.snapshot_info()
        if state == "ABSENT":
            return fail("Snapshot no existe")
        if state != "OK":
            return unknown(str(data))
        # etcdutl puede devolver claves con distintos nombres según versión.
        rev = data.get("revision", data.get("Revision"))
        count = data.get("totalKey", data.get("totalKeys", data.get("TotalKey")))
        checksum = data.get("hash", data.get("Hash"))
        if rev is None or count is None or checksum is None:
            return unknown("Campos de metadata no reconocidos: " + ", ".join(data.keys())[:100])
        try:
            if int(rev) < 1 or int(count) < 1:
                return fail("Revision o cantidad de claves inválida")
        except (TypeError, ValueError):
            return fail("Datos de metadata inválidos")
        return pass_()

    def has(self, key):
        return self.report.get("checks", {}).get(key, {}).get("state") == "PASS"

    def run_check(self, check_id):
        # Controlar secuencias: no acreditar ausencia de etcd-after si jamás fue observado.
        if check_id in ("after_namespace", "after_marker", "both_markers"):
            if not self.has("snapshot") or not self.has("snapshot_status"):
                return unknown("Primero debe quedar acreditado el snapshot")
        if check_id in ("restore_structure", "restored_hostpath", "etcd_health_restored", "container_datadir"):
            if not self.has("after_marker") or not self.has("manifest_copy"):
                return unknown("Falta evidencia previa al restore (estado posterior y backup manifiesto)")
        if check_id in ("api_ready", "nodes_final", "before_restored", "after_absent"):
            if not self.has("restored_hostpath") or not self.has("after_marker"):
                return unknown("Falta evidencia de restauración y marcador posterior")
        if check_id in ("cleanup", "backups_retained", "manifest_final"):
            if not self.has("after_absent") or not self.has("before_restored"):
                return unknown("Primero debe confirmarse el estado recuperado")
        if check_id == "nodes_initial" or check_id == "nodes_final":
            return self.nodes()
        if check_id == "etcd_manifest":
            if self.manifest is None:
                return unknown("No se puede leer manifiesto (requiere sudo)")
            return pass_() if "--data-dir=/var/lib/etcd" in self.manifest and "etcd-data" in self.manifest else fail("Falta configuración base de etcd")
        if check_id == "etcd_pod_initial":
            s, o = self.obj("pods", namespace="kube-system")
            if s != "OK":
                return unknown(str(o))
            pods = [p for p in o.get("items", []) if p.get("metadata", {}).get("labels", {}).get("component") == "etcd"]
            return pass_() if any(p.get("status", {}).get("phase") == "Running" for p in pods) else fail("etcd no está Running")
        if check_id in ("before_initial", "before_presnapshot", "before_restored"):
            if check_id == "before_presnapshot" and self.has("after_marker"):
                return unknown("No se capturó marcador antes del restore")
            return self.marker("etcd-before", "before-snapshot")
        if check_id == "binaries":
            for binary in ("etcdctl", "etcdutl"):
                rc, _, err = self.run("version:" + binary, [binary, "version"], 4)
                if rc:
                    return unknown("No se puede ejecutar " + binary + ": " + err[:80])
            return pass_()
        if check_id == "certificates":
            if not all(Path(x).is_file() and os.access(x, os.R_OK) for x in CERTS):
                return unknown("Certificados no accesibles")
            return pass_()
        if check_id in ("health_pre", "etcd_health_restored"):
            if check_id == "health_pre" and self.has("restored_hostpath"):
                return unknown("No se registró la salud pre-restore")
            return self.health("restored" if check_id == "etcd_health_restored" else "pre")
        if check_id == "backup_dir":
            return pass_() if BACKUP.is_dir() else fail("Directorio de backups no existe")
        if check_id == "snapshot":
            if not SNAP.is_file():
                return fail("Falta archivo snapshot")
            if SNAP.stat().st_size < 4096:
                return fail("Snapshot demasiado pequeño")
            # Requiere creación en esta sesión: evita adjudicar backups antiguos.
            started = self.report.get("session_start_epoch", 0)
            if SNAP.stat().st_mtime + 2 < started:
                return unknown("Snapshot preexistente; no prueba creación en esta sesión")
            if not self.has("before_initial"):
                return unknown("No se observó marcador previo antes del snapshot")
            return pass_()
        if check_id in ("snapshot_metadata", "snapshot_status"):
            if not self.has("snapshot"):
                return unknown("Snapshot aún no acreditado")
            return self.valid_snapshot_info()
        if check_id == "snapshot_duplicate":
            if not self.has("snapshot") or not ORIGINAL.is_file():
                return fail("Falta una copia del snapshot")
            try:
                return pass_() if sha(SNAP) == sha(ORIGINAL) else fail("SHA-256 de las copias difiere")
            except OSError:
                return unknown("No se pudieron leer ambos archivos")
        if check_id == "snapshot_timestamp":
            if not self.has("snapshot") or not STAMP.is_file():
                return fail("Falta timestamp de backup")
            value = file_text(STAMP) or ""
            return pass_() if re.match(r"^\d{4}-\d\d-\d\dT", value) else fail("Timestamp no tiene formato ISO")
        if check_id == "snapshot_json":
            if not self.has("snapshot_status"):
                return unknown("Aún no se validó el snapshot")
            if not STATUS.is_file():
                return fail("Falta status JSON guardado")
            try:
                data = json.loads(STATUS.read_text(encoding="utf-8"))
                return pass_() if isinstance(data, dict) and data else fail("Status JSON vacío")
            except (OSError, ValueError):
                return fail("Status JSON ilegible")
        if check_id == "after_namespace":
            return self.namespace("etcd-after")
        if check_id == "after_marker":
            return self.marker("etcd-after", "after-snapshot")
        if check_id == "both_markers":
            a, _ = self.marker("etcd-before", "before-snapshot")
            b, _ = self.marker("etcd-after", "after-snapshot")
            return pass_() if a == "PASS" and b == "PASS" else unknown("No se observaron simultáneamente los dos marcadores")
        if check_id == "manifest_copy":
            if not MANIFEST_BACKUP.is_file():
                return fail("Falta copia del manifiesto original")
            content = file_text(MANIFEST_BACKUP)
            if content is None:
                return unknown("No se pudo leer el manifiesto respaldado")
            return pass_() if parse_hostpath(content) == "/var/lib/etcd" else fail("Copia no apunta al directorio original")
        if check_id == "active_data":
            return pass_() if Path("/var/lib/etcd").is_dir() else fail("Directorio de etcd original ausente")
        if check_id == "restore_dir_fresh":
            if not self.has("manifest_copy") or not self.has("after_marker"):
                return unknown("Primero preparar backup del manifiesto y marcador posterior")
            if DATA_RESTORE.exists():
                return unknown("El destino ya existe: no se observó vacío antes del restore")
            return pass_()
        if check_id == "restore_structure":
            return pass_() if all((DATA_RESTORE / x).is_dir() for x in ("member/snap", "member/wal")) else fail("Faltan carpetas member/snap o member/wal")
        if check_id in ("restored_hostpath", "manifest_final"):
            if self.manifest is None:
                return unknown("No se puede leer etcd.yaml")
            return pass_() if parse_hostpath(self.manifest) == "/var/lib/etcd-restore" else fail("hostPath de etcd-data no apunta a /var/lib/etcd-restore")
        if check_id == "container_datadir":
            if self.manifest is None:
                return unknown("No se puede leer etcd.yaml")
            return pass_() if re.search(r"--data-dir=/var/lib/etcd(?:\s|$|\"|')", self.manifest, re.M) else fail("Se cambió --data-dir dentro del contenedor")
        if check_id == "api_ready":
            rc, out, err = self.kubectl("get", "--raw=/readyz")
            if rc:
                return unknown("API Server en recuperación: " + (err or out)[:100])
            return pass_() if out.strip() == "ok" else fail("API Server no está Ready")
        if check_id == "after_absent":
            s, o = self.obj("namespace", "etcd-after")
            if s == "ERROR":
                return unknown(str(o))
            return pass_() if s == "ABSENT" else fail("etcd-after sigue presente")
        if check_id == "cleanup":
            s, o = self.obj("namespace", "etcd-before")
            if s == "ERROR":
                return unknown(str(o))
            return pass_() if s == "ABSENT" else fail("Namespace etcd-before todavía existe")
        if check_id == "backups_retained":
            return pass_() if all(x.is_file() for x in (SNAP, ORIGINAL, STATUS, STAMP, MANIFEST_BACKUP)) else fail("Faltan archivos de respaldo")
        return unknown("Verificación desconocida")


def empty_report():
    return {"schema": 1, "lab": "lab5", "version": VERSION,
            "created_at": timestamp(), "session_start_epoch": time.time(),
            "session_id": str(uuid.uuid4()), "checks": {}}


def read_report():
    if not REPORT.exists():
        return empty_report()
    try:
        data = json.loads(REPORT.read_text(encoding="utf-8"))
        if data.get("lab") != "lab5" or not isinstance(data.get("checks"), dict):
            raise ValueError("Esquema ajeno")
        return data
    except (OSError, ValueError) as exc:
        raise RuntimeError("Reporte inválido; no se sobrescribirá: " + str(exc))


def save_report(report):
    temp = REPORT.with_suffix(".json.tmp")
    try:
        with os.fdopen(os.open(str(temp), os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600), "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, REPORT)
        os.chmod(REPORT, 0o600)
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


def evaluate(report, only_task=None):
    inspector = Inspector(report)
    changed = False
    for id_, task, points, label in CHECKS:
        if only_task and task != only_task:
            continue
        prev = report["checks"].get(id_)
        if prev and prev.get("state") == "PASS":
            continue  # Evidencia aprobada se conserva antes de cleanup/restore.
        state, detail = inspector.run_check(id_)
        if state == "PASS":
            report["checks"][id_] = {"state": "PASS", "when": timestamp()}
            changed = True
        elif prev is None or prev.get("state") != state or prev.get("detail") != detail:
            # No guardar stdout, tokens, claves ni contenido de etcd.
            report["checks"][id_] = {"state": state, "detail": detail[:200], "when": timestamp()}
            changed = True
    if changed:
        report["updated_at"] = timestamp()
        save_report(report)
    return changed


def status_task(report, task):
    items = [r for r in CHECKS if r[1] == task]
    passed = sum(p for id_, _, p, _ in items if report["checks"].get(id_, {}).get("state") == "PASS")
    recorded = [report["checks"][id_] for id_, _, _, _ in items if id_ in report["checks"]]
    if passed == TASKS[task][1]:
        state = "COMPLETADA"
    elif passed:
        state = "EN PROGRESO"
    else:
        # La ausencia de recursos al principio no demuestra que se intentó fallidamente.
        state = "NO INICIADA (SIN EVIDENCIA)"
    return passed, state


def summary(report, task=None):
    print("\nLAB 5 — EVALUACIÓN DE BACKUP Y RESTORE DE ETCD · v" + VERSION)
    print("  Estado: puntos acreditados con evidencia observable; no valida comandos exactos.")
    total = 0
    for number, (title, maximum) in TASKS.items():
        points, state = status_task(report, number)
        total += points
        print(f"  Tarea {number}: {state:27s} {points:2}/{maximum:2} pts | {title}")
        if task == number:
            for id_, t, weight, label in CHECKS:
                if t != task:
                    continue
                evidence = report["checks"].get(id_, {})
                status = evidence.get("state", "PENDIENTE")
                detail = evidence.get("detail", "")
                print(f"    [{status}] {label} ({weight} pts)" + (f" — {detail}" if detail else ""))
    complete = all(status_task(report, i)[1] == "COMPLETADA" for i in TASKS)
    print(f"  PUNTOS ACREDITADOS: {total}/100")
    print("  ESTADO GENERAL: " + ("COMPLETADA (100%)" if complete else "PROVISIONAL — práctica incompleta o evidencia insuficiente"))
    print("  Reporte:", REPORT.resolve())
    print("  NOTA: NO INICIADA = no observada por el evaluador, no prueba de que el alumno no trabajó.")


def require_host():
    import socket
    host = socket.gethostname().split(".")[0]
    if host != "cka-control":
        print(f"ERROR: este evaluador se ejecuta solo en cka-control (host detectado: {host}).", file=sys.stderr)
        return False
    if os.geteuid() != 0:
        print("ERROR: ejecuta con sudo para consultar etcd, snapshots y certificados.", file=sys.stderr)
        return False
    if not kubeconfig_path():
        print("ERROR: kubeconfig administrativo no localizado. Verifica /home/control/.kube/config.", file=sys.stderr)
        return False
    return True


def alive(pid):
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        contents = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\x00", b" ")
        return b"evaluar_lab5.py" in contents and b"--monitor-interno" in contents
    except OSError:
        return False


def monitor_pid():
    try:
        value = int(PIDFILE.read_text(encoding="utf-8").strip())
        return value if alive(value) else None
    except (OSError, ValueError):
        return None


def monitor_loop():
    stopped = False
    def stop(_sig, _frame):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopped:
        try:
            data = read_report()
            evaluate(data)
        except Exception as exc:
            print(timestamp(), "Monitor:", str(exc)[:200], flush=True)
        for _ in range(INTERVAL * 5):
            if stopped:
                break
            time.sleep(0.2)


def main():
    ap = argparse.ArgumentParser(description="Evaluador local Lab 5; solo lectura")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--iniciar", action="store_true")
    group.add_argument("--estado", action="store_true")
    group.add_argument("--tarea", type=int, choices=range(1, 10))
    group.add_argument("--completo", action="store_true")
    group.add_argument("--resumen", action="store_true")
    group.add_argument("--detener", action="store_true")
    group.add_argument("--autoprueba", action="store_true")
    group.add_argument("--monitor-interno", action="store_true", help=argparse.SUPPRESS)
    a = ap.parse_args()

    if a.autoprueba:
        scores = {t: sum(p for _, task, p, _ in CHECKS if task == t) for t in TASKS}
        assert scores == {t: points for t, (_, points) in TASKS.items()}
        assert sum(scores.values()) == 100
        assert len({x[0] for x in CHECKS}) == len(CHECKS)
        sample = '  - hostPath:\n      path: /var/lib/etcd-restore\n      type: DirectoryOrCreate\n    name: etcd-data\n'
        assert parse_hostpath(sample) == "/var/lib/etcd-restore"
        print(f"AUTOPRUEBA OK — v{VERSION}, 9 tareas, {len(CHECKS)} verificaciones, 100 puntos; parser hostPath OK")
        return 0

    if not require_host():
        return 2

    if a.monitor_interno:
        monitor_loop()
        return 0

    if a.iniciar:
        if monitor_pid():
            print("Monitor ya activo. PID:", monitor_pid())
            return 0
        report = read_report()
        if not REPORT.exists():
            save_report(report)
        # Registrar su configuración efectiva sin tocar el clúster.
        with LOGFILE.open("a", encoding="utf-8") as log:
            p = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--monitor-interno"],
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 start_new_session=True, cwd=str(Path.cwd()))
        PIDFILE.write_text(str(p.pid), encoding="utf-8")
        print(f"Monitor iniciado (PID {p.pid}), cada {INTERVAL}s. Reporte: {REPORT.resolve()}")
        print("Déjalo activo desde la Tarea 1 hasta terminar la Tarea 9.")
        return 0

    if a.estado:
        pid = monitor_pid()
        print("Monitor ACTIVO" + f" (PID {pid})" if pid else "Monitor DETENIDO")
        if REPORT.exists():
            summary(read_report())
        return 0

    if a.detener:
        pid = monitor_pid()
        if pid:
            os.kill(pid, signal.SIGTERM)
            print("Señal de detención enviada al monitor", pid)
        else:
            print("Monitor ya estaba detenido")
        try:
            PIDFILE.unlink(missing_ok=True)
        except OSError:
            pass
        return 0

    report = read_report()
    if a.resumen:
        summary(report)
        return 0
    if a.tarea:
        evaluate(report, a.tarea)
        summary(report, a.tarea)
        return 0
    if a.completo:
        evaluate(report)
        summary(report)
        return 0
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError) as exc:
        print("ERROR:", exc, file=sys.stderr)
        sys.exit(2)
