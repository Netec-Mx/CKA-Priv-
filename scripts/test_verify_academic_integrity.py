#!/usr/bin/env python3
"""Regression tests for the academic integrity gate (standard library only)."""
from pathlib import Path
from tempfile import TemporaryDirectory
import subprocess
import sys
import unittest

VERIFIER = Path(__file__).with_name("verify_academic_integrity.py")

ORIGINAL = """---
layout: lab
title: "Ejercicio"
---
## Tarea 1. Preparación

- {% include step_label.html %} Ejecuta `kubectl get nodes`.

## Tarea 2. Comprobación

- {% include step_label.html %} Confirma que el clúster responde.
"""

def cmd(cwd, *args):
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, encoding="utf-8")

def migrated(original):
    front = original.replace(
        'layout: lab\n',
        'course_id: ckapriv\nlab_id: l001\ntracking: true\nposition: 1\nlayout: lab\n',
        1,
    )
    front = front.replace(
        '- {% include step_label.html %} Ejecuta',
        '{% assign tracking_task_id = "t001" %}\n\n- {% include step_label.html id="s001" %} Ejecuta',
        1,
    )
    front = front.replace(
        '- {% include step_label.html %} Confirma',
        '{% assign tracking_task_id = "t002" %}\n\n- {% include step_label.html id="s002" %} Confirma',
        1,
    )
    return front

class AcademicIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for args in [
            ("git", "init", "-q"),
            ("git", "config", "user.email", "test@example.invalid"),
            ("git", "config", "user.name", "Test"),
        ]:
            self.assertEqual(cmd(self.root, *args).returncode, 0)
        for number in (1, 2):
            directory = self.root / "labs" / f"lab{number}"
            directory.mkdir(parents=True)
            (directory / f"lab{number}.md").write_text(ORIGINAL, encoding="utf-8")
        # A supplementary file without Jekyll frontmatter must be ignored.
        (self.root / "labs/lab2/lab2_sol.md").write_text("Solución auxiliar", encoding="utf-8")
        self.assertEqual(cmd(self.root, "git", "add", ".").returncode, 0)
        self.assertEqual(cmd(self.root, "git", "commit", "-qm", "baseline").returncode, 0)
        for number in (1, 2):
            path = self.root / "labs" / f"lab{number}" / f"lab{number}.md"
            updated = migrated(path.read_text(encoding="utf-8"))
            updated = updated.replace("lab_id: l001", f"lab_id: l{number:03d}")
            path.write_text(updated, encoding="utf-8")

    def verify(self):
        return cmd(self.root, sys.executable, str(VERIFIER))

    def test_metadata_only_adoption_preserves_academics(self):
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2 Labs", result.stdout)

    def test_changed_academic_command_is_rejected(self):
        file = self.root / "labs/lab1/lab1.md"
        file.write_text(file.read_text(encoding="utf-8").replace("kubectl get nodes", "kubectl delete nodes"), encoding="utf-8")
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("instrucciones académicas cambiaron", result.stderr)

    def test_missing_main_lab_file_is_rejected(self):
        (self.root / "labs/lab2/lab2.md").unlink()
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Falta archivo principal", result.stderr)

    def test_missing_lab_directory_in_sequence_is_rejected(self):
        (self.root / "labs/lab2").rename(self.root / "labs/lab3")
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Secuencia de laboratorios incompleta", result.stderr)

if __name__ == "__main__":
    unittest.main(verbosity=2)
