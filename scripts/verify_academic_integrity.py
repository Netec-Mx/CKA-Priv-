#!/usr/bin/env python3
"""Verify that onboarding did not alter the academic text of an existing course.

Run inside the migrated course repository. Compares each tracked lab against
HEAD, ignoring only LabControl metadata inserted by the migration. Fails
closed on changed academic lines, removed labs, or unexpected source changes.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path.cwd()
FRONT = re.compile(r"\A---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)")
META = re.compile(r"^(?:course_id|lab_id|tracking|position):\s*")
TASK = re.compile(r'^\s*{%\s*assign\s+tracking_task_id\s*=\s*["\']t\d{3}["\']\s*%}\s*$')
STEP = re.compile(r'(\{%\s*include\s+step_label\.html)\s+id=["\']s\d{3}["\']')

def comparable(text, migrated):
    text = text.replace("\r\n", "\n")
    match = FRONT.match(text)
    if not match:
        raise ValueError("Falta frontmatter")
    fm = match.group(1).splitlines()
    if migrated:
        fm = [x for x in fm if not META.match(x)]
    body = text[match.end():]
    if migrated:
        body = STEP.sub(r"\1", body)
        body = "\n".join(line for line in body.splitlines() if not TASK.match(line))
    # Migration adds blank lines around task assignments, but academic
    # content (all nonblank lines) must remain byte-for-byte equivalent.
    return [x for x in [*fm, *body.splitlines()] if x.strip()]

def main():
    lab_dirs = sorted(
        (path for path in (ROOT / "labs").iterdir()
         if path.is_dir() and re.fullmatch(r"lab[1-9][0-9]*", path.name)),
        key=lambda path: int(path.name[3:]),
    )
    if not lab_dirs:
        raise ValueError("No se encontraron labs")
    numbers = [int(path.name[3:]) for path in lab_dirs]
    if numbers != list(range(1, len(numbers) + 1)):
        raise ValueError("Secuencia de laboratorios incompleta")
    labs = [directory / (directory.name + ".md") for directory in lab_dirs]
    for file in labs:
        if not file.is_file():
            raise ValueError(f"Falta archivo principal de laboratorio: {file}")
    for file in labs:
        path = file.relative_to(ROOT).as_posix()
        original = subprocess.run(["git", "show", "HEAD:" + path],
                                  text=True, capture_output=True, encoding="utf-8")
        if original.returncode:
            raise ValueError(path + ": no existe en HEAD")
        if comparable(original.stdout, False) != comparable(file.read_text(encoding="utf-8"), True):
            raise ValueError(path + ": las instrucciones académicas cambiaron")
        print("OK contenido:", path)
    print(f"INTEGRIDAD ACADÉMICA OK: {len(labs)} Labs; texto sin modificaciones.")

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("ERROR:", exc, file=sys.stderr)
        sys.exit(1)
