#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ID_REGISTRY="${SCRIPT_DIR}/lab_id_registry.mjs"
MANIFEST_GENERATOR="${SCRIPT_DIR}/generate_lab_manifest.mjs"
NORMALIZER="${SCRIPT_DIR}/normalize_course_labs.mjs"

ROOT_DIR="${ROOT_DIR:-labs}"

POSITION="${1:-}"
COURSE_ID="${2:-}"

if [[ -z "${POSITION}" || -z "${COURSE_ID}" ]]; then
  echo "Uso:"
  echo "  $0 <position> <course_id>"
  echo
  echo "Ejemplo:"
  echo "  $0 2 terraform-aws-essentials"
  exit 1
fi

if ! [[ "${POSITION}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: position debe ser un entero mayor que 0."
  exit 1
fi

if ! [[ "${COURSE_ID}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "Error: course_id debe usar kebab-case."
  exit 1
fi

for required in \
  "${ID_REGISTRY}" \
  "${MANIFEST_GENERATOR}" \
  "${NORMALIZER}"
do
  if [[ ! -f "${required}" ]]; then
    echo "Error: no se encontró ${required}"
    exit 1
  fi
done

mkdir -p "${ROOT_DIR}"

echo
echo "Insertando Lab:"
echo "  Course ID: ${COURSE_ID}"
echo "  Posición nueva: ${POSITION}"
echo "  Directorio: ${ROOT_DIR}"
echo

shopt -s nullglob

declare -a COURSE_FILES=()

MAX_FOLDER_NUM=0
CURRENT_ACTIVE_COUNT=0

for file in "${ROOT_DIR}"/lab*/lab*.md; do
  course="$(
    sed -n 's/^course_id:[[:space:]]*//p' "${file}" |
      head -n 1 |
      tr -d '\r'
  )"

  tracking="$(
    sed -n 's/^tracking:[[:space:]]*//p' "${file}" |
      head -n 1 |
      tr -d '\r'
  )"

  if [[ "${course}" != "${COURSE_ID}" || "${tracking}" != "true" ]]; then
    continue
  fi

  COURSE_FILES+=("${file}")
  CURRENT_ACTIVE_COUNT=$((CURRENT_ACTIVE_COUNT + 1))

  folder="$(
    basename "$(dirname "${file}")"
  )"

  folder_num="${folder#lab}"

  if [[ "${folder_num}" =~ ^[0-9]+$ ]] &&
     (( folder_num > MAX_FOLDER_NUM )); then
    MAX_FOLDER_NUM="${folder_num}"
  fi

  existing_lab_id="$(
    sed -n 's/^lab_id:[[:space:]]*//p' "${file}" |
      head -n 1 |
      tr -d '\r'
  )"

  if [[ "${existing_lab_id}" =~ ^l[0-9]{3}$ ]]; then
    node "${ID_REGISTRY}" \
      register \
      "${COURSE_ID}" \
      "${existing_lab_id}" \
      >/dev/null
  fi
done

shopt -u nullglob

NEW_TOTAL=$((CURRENT_ACTIVE_COUNT + 1))

if (( POSITION > NEW_TOTAL )); then
  echo "Error: position ${POSITION} está fuera del rango válido 1..${NEW_TOTAL}."
  exit 1
fi

echo "Labs actuales: ${CURRENT_ACTIVE_COUNT}"
echo "Nuevo total: ${NEW_TOTAL}"

for file in "${COURSE_FILES[@]}"; do
  current_position="$(
    sed -n 's/^position:[[:space:]]*//p' "${file}" |
      head -n 1 |
      tr -d '\r'
  )"

  if ! [[ "${current_position}" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: ${file} no tiene position válida."
    exit 1
  fi

  if (( current_position >= POSITION )); then
    new_position=$((current_position + 1))

    python - "${file}" "${new_position}" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
new_position = sys.argv[2]

text = path.read_text(encoding="utf-8")

text, count_number = re.subn(
    r"(?m)^lab_number:\s*\d+\s*$",
    f"lab_number: {new_position}",
    text,
    count=1,
)

text, count_position = re.subn(
    r"(?m)^position:\s*\d+\s*$",
    f"position: {new_position}",
    text,
    count=1,
)

if count_number != 1 or count_position != 1:
    raise SystemExit(
        f"No se pudo actualizar lab_number/position en {path}"
    )

path.write_text(
    text,
    encoding="utf-8",
)

PY
  fi
done

NEW_FOLDER_NUM=$((MAX_FOLDER_NUM + 1))
NEW_DIR="${ROOT_DIR}/lab${NEW_FOLDER_NUM}"
NEW_FILE="${NEW_DIR}/lab${NEW_FOLDER_NUM}.md"
NEW_IMG_DIR="${NEW_DIR}/img"

NEW_LAB_ID="$(
  node "${ID_REGISTRY}" next "${COURSE_ID}"
)"

mkdir -p "${NEW_IMG_DIR}"

cat > "${NEW_FILE}" <<EOF2
---
layout: lab
course_id: ${COURSE_ID}
lab_id: ${NEW_LAB_ID}
tracking: true

title: "Práctica ${POSITION}: CAMBIAR_AQUI_NOMBRE_DE_LA_PRACTICA"
permalink: /lab${NEW_FOLDER_NUM}/lab${NEW_FOLDER_NUM}/
images_base: /labs/lab${NEW_FOLDER_NUM}/img
duration: "## minutos"
objective:
  - OBJETIVO_DE_LA_PRACTICA
prerequisites:
  - PREREQUISITO_1
introduction:
  - INTRODUCCION_DE_LA_PRACTICA_BREVE_RESUMEN_EN_UN_SOLO_PARRAFO_RECOMENDADO
slug: lab${NEW_FOLDER_NUM}
lab_number: ${POSITION}
position: ${POSITION}
final_result: >
  RESULTADO_FINAL_ESPERADO_DE_LA_PRACTICA_EN_UN_SOLO_PARRAFO_RECOMENDADO
notes:
  - NOTAS_CONSIDERACIONES_ADICIONALES
references:
  - text: DESCRIPCION_DEL_LINK_DE_REFERENCIA
    url: https://example.com
prev: /
next: /
---

---

## 🔎 Tarea 1. NOMBRE DE LA TAREA — ## min

{% assign tracking_task_id = "t001" %}

### Tarea 1.1. NOMBRE_DE_LA_SUBTAREA

- {% include step_label.html id="s001" %} DESCRIPCION_DEL_PASO_1.

- {% include step_label.html id="s002" %} DESCRIPCION_DEL_PASO_2.

- {% include step_label.html id="s003" %} DESCRIPCION_DEL_PASO_3.
EOF2

echo
echo "Nuevo Lab:"
echo "  Archivo: ${NEW_FILE}"
echo "  lab_id: ${NEW_LAB_ID}"
echo "  position: ${POSITION}"
echo

echo "Normalizando estructura y navegación..."

ROOT_DIR="${ROOT_DIR}" \
  node "${NORMALIZER}" \
  "${COURSE_ID}"

echo
echo "Regenerando manifests del curso..."

for file in "${COURSE_FILES[@]}" "${NEW_FILE}"; do
  node "${MANIFEST_GENERATOR}" "${file}" >/dev/null
done

echo
echo "Inserción completada."
