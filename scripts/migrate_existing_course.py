#!/usr/bin/env python3
"""Migrate existing Jekyll labs to stable Lab Control IDs without rewriting instructions.

Dry-run by default. Only adds YAML keys, task assignments, and step IDs.
Never overwrites an existing course file outside labs or changes step wording.
"""
from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

COURSE_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
LAB_FILE = re.compile(r"^lab([1-9][0-9]*)$")
FRONT = re.compile(r"\A---\r?\n([\s\S]*?)\r?\n---\r?\n")
TASK = re.compile(r"^##\s+\S")
STEP = re.compile(r"{%\s*include\s+step_label\.html\b([^%]*)%}")
ID = re.compile(r"\bid\s*=\s*['\"]([^'\"]+)['\"]")
TASK_ASSIGN = re.compile(r"{%\s*assign\s+tracking_task_id\s*=")
COPY_DIRS = ("scripts", "_includes", "_layouts", "assets/js")
COPY_FILES = (".github/workflows/pages.yml",)


def prepare_lab(path: Path, course_id: str, number: int) -> tuple[str, int, int]:
    original = path.read_text(encoding="utf-8")
    match = FRONT.match(original)
    if not match:
        raise ValueError(f"{path}: falta YAML frontmatter válido")
    fm = match.group(1)
    body = original[match.end():]
    additions = []
    expected = {"course_id": course_id, "lab_id": f"l{number:03d}",
                "tracking": "true", "lab_number": str(number), "position": str(number)}
    for field, desired in expected.items():
        field_match = re.search(rf"(?m)^{field}\s*:\s*([^#\r\n]+)", fm)
        if field_match and field in ("course_id", "lab_id", "tracking"):
            raise ValueError(f"{path}: {field} ya existe; revisar migración previa")
        if field_match:
            actual = field_match.group(1).strip().strip(chr(39) + chr(34))
            if actual != desired:
                raise ValueError(f"{path}: {field}={actual!r}, se esperaba {desired!r}")
        else:
            additions.append(f"{field}: {desired}\n")
    header = "".join(additions)
    output_body = []
    task_no = 0
    step_no = 0
    section = 0
    active_section = -1
    in_comment = False
    in_fence = False
    for line in body.splitlines(keepends=True):
        trimmed = line.strip()
        if trimmed.startswith("```") or trimmed.startswith("~~~"):
            in_fence = not in_fence
        is_comment = in_comment or "<!--" in line
        if not in_fence and not is_comment and TASK.match(line):
            section += 1
        if not in_fence and not is_comment and STEP.search(line):
            if len(STEP.findall(line)) != 1:
                raise ValueError(f"{path}: más de un step_label en una línea")
            if ID.search(STEP.search(line).group(1)):
                raise ValueError(f"{path}: el paso ya tiene id; revisión manual")
            if active_section != section:
                task_no += 1
                active_section = section
                output_body.append(f'\n{{% assign tracking_task_id = "t{task_no:03d}" %}}\n\n')
            step_no += 1
            output_body.append(STEP.sub(
                lambda m: m.group(0).replace("step_label.html", f'step_label.html id="s{step_no:03d}"', 1),
                line, count=1
            ))
        else:
            output_body.append(line)
        if "-->" in line:
            in_comment = False
        elif "<!--" in line:
            in_comment = True
    if task_no == 0 or step_no == 0:
        raise ValueError(f"{path}: se requieren tareas y step_label existentes")
    eol = "\r\n" if "\r\n" in original else "\n"
    new_front = "---\n" + header + fm + "\n---\n"
    result = new_front + "".join(output_body)
    if eol == "\r\n":
        result = result.replace("\n", "\r\n")
    return result, task_no, step_no


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, type=Path, help="Root of existing Jekyll course")
    parser.add_argument("--template", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--apply", action="store_true", help="Write files (default: dry-run)")
    args = parser.parse_args()
    if not COURSE_ID.fullmatch(args.course_id):
        parser.error("course-id debe ser minúsculas, números o guiones")
    root = args.target.resolve()
    template = args.template.resolve()
    if root == template:
        parser.error("target y template deben ser directorios diferentes")
    if not (root / "labs").is_dir():
        parser.error("target/labs no existe")
    labs = []
    for child in (root / "labs").iterdir():
        m = LAB_FILE.fullmatch(child.name)
        if m and (child / f"{child.name}.md").is_file():
            labs.append((int(m.group(1)), child / f"{child.name}.md"))
    labs.sort()
    if not labs or [n for n, _ in labs] != list(range(1, len(labs) + 1)):
        parser.error("se requieren lab1..labN sin huecos")
    planned = []
    total_tasks = total_steps = 0
    for number, labfile in labs:
        result, tasks, steps = prepare_lab(labfile, args.course_id, number)
        planned.append((labfile, result))
        total_tasks += tasks
        total_steps += steps
    registry = root / "_data/labcontrol-identities.yml"
    if registry.exists():
        parser.error("ya existe registro de identidades; no se reemplazará")
    record = (f"{args.course_id}:\n  next_lab_id: {len(labs)+1}\n"
              "  used_lab_ids:\n" +
              "".join(f"    - l{i:03d}\n" for i in range(1, len(labs)+1)))
    print(f"Curso: {args.course_id} | Labs: {len(labs)} | Tareas: {total_tasks} | Pasos: {total_steps}")
    print("Modo:", "APPLY" if args.apply else "DRY RUN")
    if not args.apply:
        print("No se modificó ningún archivo. Ejecuta con --apply para migrar.")
        return
    backup = root / ".migration-backup-labcontrol"
    if backup.exists():
        parser.error("existe .migration-backup-labcontrol; revisa antes de repetir")
    for labfile, _ in planned:
        dest = backup / labfile.relative_to(root)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(labfile, dest)
    copied = []
    for dirname in COPY_DIRS:
        source = template / dirname
        if not source.is_dir():
            continue
        for item in source.rglob("*"):
            if not item.is_file():
                continue
            relative = item.relative_to(template)
            target = root / relative
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, target)
                copied.append(str(relative))
    for filename in COPY_FILES:
        source, dest = template / filename, root / filename
        if source.is_file() and not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
            copied.append(filename)
    for labfile, result in planned:
        labfile.write_text(result, encoding="utf-8", newline="")
    # Preserve existing Jekyll configuration and add a missing tracking API.
    config = root / "_config.yml"
    if config.is_file():
        current_config = config.read_text(encoding="utf-8")
        if not re.search(r"(?m)^\s*labcontrol_api_url\s*:", current_config):
            destination = backup / "_config.yml"
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(config, destination)
            with config.open("a", encoding="utf-8") as stream:
                stream.write("\n# Lab Control API (public URL; no secrets)\n")
                stream.write('labcontrol_api_url: "https://labcontrol.superwebapp.com/api"\n')
            print("OK: API de Lab Control agregada a _config.yml")
        else:
            print("INFO: labcontrol_api_url existente; verificar su valor antes de publicar")
    # A published challenge/proof needs this dot-directory in GitHub Pages.
    # Never copy an actual proof from the template or another course.
    if config.is_file():
        current_config = config.read_text(encoding="utf-8")
        if not re.search(r"(?m)^\s*-\s*\.well-known\s*$", current_config):
            destination = backup / "_config.yml"
            if not destination.exists():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(config, destination)
            if re.search(r"(?m)^include:\s*$", current_config):
                current_config = re.sub(
                    r"(?m)^(include:\s*\n)",
                    lambda m: m.group(1) + "  - .well-known\n",
                    current_config,
                    count=1,
                )
            elif not re.search(r"(?m)^include:", current_config):
                current_config += "\ninclude:\n  - .well-known\n"
            else:
                parser.error("include de _config.yml es formato no reconocido: integrar .well-known manualmente")
            config.write_text(current_config, encoding="utf-8")
            print("OK: include de .well-known agregado a _config.yml")
    registry.parent.mkdir(parents=True, exist_ok=True)
    registry.write_text(record, encoding="utf-8")
    print(f"OK: {len(labs)} labs migrados; backup en {backup}")
    print(f"Archivos de tooling copiados (solo ausentes): {len(copied)}")
    print("Revisa _config.yml, _data/courses.yml, Jekyll build y el diff antes del commit.")
    print("Después: node scripts/generate_lab_manifest.mjs --all")
    print("         node scripts/generate_course_catalog.mjs")


if __name__ == "__main__":
    main()
