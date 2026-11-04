#!/usr/bin/env python3
"""Regression tests for safe existing-course migration."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("migrate_existing_course.py")
FIXTURE = """---
layout: lab
title: "Práctica de ejemplo"
---

## Tarea 1. Preparar

- {% include step_label.html %} Primer paso sin modificar.
- {% include step_label.html %} Segundo paso **importante**.

## Tarea 2. Verificar

- {% include step_label.html %} Verificar resultado.
"""


class MigrationTest(unittest.TestCase):
    def run_migration(self, root, template, apply=False):
        args = [sys.executable, str(SCRIPT), "--target", str(root),
                "--template", str(template), "--course-id", "curso-demo"]
        if apply:
            args.append("--apply")
        return subprocess.run(args, text=True, capture_output=True)

    def test_dry_run_and_apply_preserve_instructions(self):
        with tempfile.TemporaryDirectory() as d:
            root, template = Path(d)/"existing", Path(d)/"template"
            source = root/"labs/lab1/lab1.md"
            source.parent.mkdir(parents=True)
            source.write_text(FIXTURE, encoding="utf-8")
            (template/"scripts").mkdir(parents=True)
            (template/"scripts/dummy.mjs").write_text("// tool", encoding="utf-8")
            (root/"_config.yml").write_text("title: Demo\\ninclude:\\n  - assets\\n", encoding="utf-8")
            original = source.read_bytes()
            dry = self.run_migration(root, template)
            self.assertEqual(dry.returncode, 0, dry.stderr)
            self.assertEqual(source.read_bytes(), original)
            applied = self.run_migration(root, template, True)
            self.assertEqual(applied.returncode, 0, applied.stderr)
            result = source.read_text(encoding="utf-8")
            self.assertIn("lab_id: l001", result)
            self.assertIn('tracking_task_id = "t002"', result)
            self.assertIn('step_label.html id="s003"', result)
            self.assertIn("Primer paso sin modificar.", result)
            self.assertEqual(
                (root/".migration-backup-labcontrol/labs/lab1/lab1.md").read_bytes(), original
            )
            self.assertIn("next_lab_id: 2", (root/"_data/labcontrol-identities.yml").read_text())
            self.assertTrue((root/"scripts/dummy.mjs").exists())
            config = (root/"_config.yml").read_text(encoding="utf-8")
            self.assertIn("  - .well-known", config)
            self.assertIn("  - assets", config)
            self.assertIn("title: Demo", (root/".migration-backup-labcontrol/_config.yml").read_text(encoding="utf-8"))

    def test_does_not_overwrite_existing_tracking(self):
        with tempfile.TemporaryDirectory() as d:
            root, template = Path(d)/"existing", Path(d)/"template"
            source = root/"labs/lab1/lab1.md"
            source.parent.mkdir(parents=True)
            source.write_text(FIXTURE.replace("layout: lab", "layout: lab\nlab_id: l001"))
            (template/"scripts").mkdir(parents=True)
            result = self.run_migration(root, template, True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root/".migration-backup-labcontrol").exists())


if __name__ == "__main__":
    unittest.main()
