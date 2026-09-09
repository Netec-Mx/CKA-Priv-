#!/usr/bin/env bash
# ------------------------------------------------------------
# Script: update_support_prompts.sh
# Descripción:
#   - Crea la carpeta _data/support_prompts si no existe.
#   - Crea los archivos lab1.yml..labN.yml.
#   - Dentro de cada archivo crea tarea1..tareaM.
#   - Si un archivo ya existe, conserva su contenido y solo agrega
#     las tareas faltantes.
#   - No sobrescribe prompts existentes.
#
# Uso:
#   1) Dar permisos de ejecución (solo la primera vez):
#        chmod +x scripts/update_support_prompts.sh
#
#   2) Ejecutar, por ejemplo:
#        ./scripts/update_support_prompts.sh 5 4
#
#      Esto crea:
#        _data/support_prompts/lab1.yml
#        ...
#        _data/support_prompts/lab5.yml
#
#      Cada archivo tendrá:
#        tarea1
#        ...
#        tarea4
#
# ------------------------------------------------------------

set -euo pipefail

DATA_DIR="_data"
PROMPTS_DIR="${DATA_DIR}/support_prompts"

TOTAL_LABS="${1:-}"
TOTAL_TASKS="${2:-}"

if [[ -z "${TOTAL_LABS}" || -z "${TOTAL_TASKS}" ]]; then
  echo "Uso: $0 <TOTAL_LABS> <TOTAL_TAREAS_POR_LAB>"
  echo "Ejemplo: $0 5 4"
  exit 1
fi

if ! [[ "${TOTAL_LABS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: TOTAL_LABS debe ser un número entero mayor que 0."
  exit 1
fi

if ! [[ "${TOTAL_TASKS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: TOTAL_TAREAS_POR_LAB debe ser un número entero mayor que 0."
  exit 1
fi

mkdir -p "${PROMPTS_DIR}"

create_task_block() {
  local lab_number="$1"
  local task_number="$2"

  cat <<EOF
tarea${task_number}:
  title: "Explicar la Tarea ${task_number} con IA"
  prompt: >-
    Explícame expertamente qué hice en la Tarea ${task_number} de la
    Práctica ${lab_number} de Couchbase Server.

    CONTEXTO_DE_LA_TAREA_${task_number}_AQUI.

    Explica el propósito de cada comando, configuración o procedimiento,
    cómo interpretar las salidas esperadas, cómo validar que la tarea se
    completó correctamente y qué errores comunes podrían presentarse.

EOF
}

for lab_number in $(seq 1 "${TOTAL_LABS}"); do
  LAB_FILE="${PROMPTS_DIR}/lab${lab_number}.yml"

  # CASO 1: El archivo del laboratorio no existe
  if [[ ! -f "${LAB_FILE}" ]]; then
    echo "Creando ${LAB_FILE} con ${TOTAL_TASKS} tareas..."

    {
      echo "# Prompts de apoyo para la Práctica ${lab_number}"
      echo "# El slug del laboratorio debe ser: lab${lab_number}"
      echo

      for task_number in $(seq 1 "${TOTAL_TASKS}"); do
        create_task_block "${lab_number}" "${task_number}"
      done
    } > "${LAB_FILE}"

    continue
  fi

  # CASO 2: El archivo ya existe
  echo "${LAB_FILE} ya existe. Revisando tareas..."

  CURRENT_MAX="$(
    awk '
      match($0, /^tarea([0-9]+):[[:space:]]*$/, result) {
        number = result[1] + 0
        if (number > max) {
          max = number
        }
      }
      END {
        print max + 0
      }
    ' "${LAB_FILE}"
  )"

  echo "Tareas existentes en lab${lab_number}: ${CURRENT_MAX}"

  if (( TOTAL_TASKS <= CURRENT_MAX )); then
    echo "No se agregan tareas nuevas a lab${lab_number}."
    continue
  fi

  START_TASK=$((CURRENT_MAX + 1))

  echo "Agregando tarea${START_TASK}..tarea${TOTAL_TASKS} a lab${lab_number}..."

  if [[ -s "${LAB_FILE}" ]]; then
    printf '\n' >> "${LAB_FILE}"
  fi

  for task_number in $(seq "${START_TASK}" "${TOTAL_TASKS}"); do
    create_task_block "${lab_number}" "${task_number}" >> "${LAB_FILE}"
  done
done

echo
echo "Proceso finalizado."
echo "Directorio generado o actualizado: ${PROMPTS_DIR}"
echo
echo "Usa este llamado al final de cada tarea:"
echo '{% include support-prompt.html task="tarea1" %}'