#!/usr/bin/env bash
# ------------------------------------------------------------
# Script: update_courses_yml.sh
# Descripción:
#   - Agrega o actualiza la entrada de un curso en _data/courses.yml.
#   - Primera vez: crea el curso y labs 1..N.
#   - Siguientes veces: si el curso ya existe, detecta cuántos labs hay
#     y solo agrega los labs faltantes hasta N (lab(N_existente+1)..labN).
#
# Uso:
#   1) Dar permisos de ejecución (solo la primera vez):
#        chmod +x scripts/update_courses_yml.sh
#
#   2) Ejecutar, por ejemplo:
#        ./scripts/update_courses_yml.sh terraform_aws_essentials 3
#
# ------------------------------------------------------------

set -euo pipefail

DATA_DIR="_data"
COURSES_FILE="${DATA_DIR}/courses.yml"

COURSE_ID="${1:-}"
TOTAL_LABS="${2:-}"

if [[ -z "${COURSE_ID}" || -z "${TOTAL_LABS}" ]]; then
  echo "Uso: $0 <ID_CURSO> <TOTAL_LABS>"
  echo "Ejemplo: $0 terraform_aws_essentials 5"
  exit 1
fi

mkdir -p "${DATA_DIR}"

# Crear el archivo si no existe
if [[ ! -f "${COURSES_FILE}" ]]; then
  echo "# Archivo de definición de cursos" > "${COURSES_FILE}"
fi

# ------------------------------------------------------------
# CASO 1: El curso NO existe aún -> creamos toda la sección
# ------------------------------------------------------------
if ! grep -q "^${COURSE_ID}:" "${COURSES_FILE}"; then
  echo "No existe entrada para '${COURSE_ID}'. Creando nueva con ${TOTAL_LABS} labs..."

  cat >> "${COURSES_FILE}" <<EOF
# _data/courses.yml
${COURSE_ID}:
  title: "NOMBRE_DEL_CURSO_AQUI" # COLOCAR EL NOMBRE DEL CURSO
  intro: "DESCRIPCIÓN_DEL_CURSO_AQUI"
  labs:

EOF

  for i in $(seq 1 "${TOTAL_LABS}"); do
    cat >> "${COURSES_FILE}" <<EOF
    - id: lab${i} 
      title: "NOMBRE_DE_LA_PRACTICA_${i}" # NOMBRE DE LA PRACTICA
      url:  "/lab${i}/lab${i}/"
      duration: "## min" # AJUSTAR TIEMPO DE LA PRACTICA
      desc: "DESCRIPCION_CORTA_DE_LA_PRACTICA" # DESCRIPCION BREVE DE LA PRACTICA 100-120 CARACTERES

EOF
  done

  # Bloque comentado de sub-práctica (solo se añade la primera vez)
  cat >> "${COURSES_FILE}" <<'EOF'
    # ESTRUCTURA DE SUB-PRACTICA OCUPAR SI ES NECESARIO SINO BORRAR
    # - id: lab61
    #   number: "6.1"
    #   title: "Despliegue de servicios en Docker Swarm"
    #   url:  "/capitulo6/lab61/"
    #   duration: "60 min"
    #   desc: "DESCRIPCION_CORTA_DE_LA_PRACTICA" # DESCRIPCION BREVE DE LA PRACTICA 100-120 CARACTERES
EOF

  echo "Listo. Curso '${COURSE_ID}' añadido a ${COURSES_FILE}."
  exit 0
fi

# ------------------------------------------------------------
# CASO 2: El curso YA existe -> solo agregamos labs faltantes
# ------------------------------------------------------------

echo "El curso '${COURSE_ID}' ya existe. Analizando labs existentes..."

# Encontrar:
#  - CURRENT_MAX: número de lab máximo encontrado (lab1, lab2, ...)
#  - INSERTION_LINE: última línea NO comentada dentro del curso
read -r CURRENT_MAX INSERTION_LINE <<<"$(awk -v course="$COURSE_ID" '
BEGIN {
  in_course = 0
  max = 0
  insertion_line = 0
}
{
  # Detectar inicio del bloque del curso
  if ($0 ~ ("^" course ":")) {
    in_course = 1
  } else if (in_course && $0 ~ /^[^[:space:]]+:/) {
    # Llegamos a otro bloque top-level -> salimos del curso
    in_course = 0
  }

  if (in_course) {
    # Ignorar líneas completamente comentadas (espacios + #)
    if ($0 ~ /^[[:space:]]*#/) {
      next
    }

    # Para cualquier línea NO comentada dentro del curso,
    # la tomamos como posible línea de inserción
    insertion_line = NR

    # Buscar líneas tipo: "    - id: lab3"
    if ($0 ~ /- id: lab[0-9]+/) {
      if (match($0, /lab([0-9]+)/, a)) {
        n = a[1] + 0
        if (n > max) {
          max = n
        }
      }
    }
  }
}
END {
  if (insertion_line > 0) {
    printf("%d %d\n", max, insertion_line)
  }
}
' "${COURSES_FILE}")"

if [[ -z "${INSERTION_LINE:-}" ]]; then
  echo "No se pudo determinar la posición de inserción para '${COURSE_ID}'. Revisa el formato de ${COURSES_FILE}."
  exit 1
fi

CURRENT_MAX=${CURRENT_MAX:-0}

echo "Labs existentes para '${COURSE_ID}': ${CURRENT_MAX}"

# Si el total solicitado es menor o igual al máximo existente, no hacemos nada
if (( TOTAL_LABS <= CURRENT_MAX )); then
  echo "Ya existen ${CURRENT_MAX} labs, y solicitaste ${TOTAL_LABS}. No se agregan labs nuevos."
  exit 0
fi

START_NEW=$((CURRENT_MAX + 1))

echo "Se agregarán labs desde lab${START_NEW} hasta lab${TOTAL_LABS}..."

TMP_FILE="${COURSES_FILE}.tmp"

# Copiamos todo hasta la línea de inserción (incluyéndola)
head -n "${INSERTION_LINE}" "${COURSES_FILE}" > "${TMP_FILE}"

# Agregamos los nuevos labs DESPUÉS de la última línea no comentada
for i in $(seq "${START_NEW}" "${TOTAL_LABS}"); do
  cat >> "${TMP_FILE}" <<EOF
    - id: lab${i}
      title: "NOMBRE_DE_LA_PRACTICA_${i}" # NOMBRE DE LA PRACTICA
      url:  "/lab${i}/lab${i}/"
      duration: "## min"
      desc: "DESCRIPCION_CORTA_DE_LA_PRACTICA" # DESCRIPCION BREVE DE LA PRACTICA 100-120 CARACTERES

EOF
done

# Añadimos el resto del archivo después de la línea de inserción
tail -n +"$((INSERTION_LINE + 1))" "${COURSES_FILE}" >> "${TMP_FILE}"

mv "${TMP_FILE}" "${COURSES_FILE}"

echo "Listo. Agregados labs lab${START_NEW}..lab${TOTAL_LABS} al curso '${COURSE_ID}'."
