#!/usr/bin/env bash
# ------------------------------------------------------------
# Script: update_task_results_yml.sh
# Descripción:
#   Gestiona el archivo _data/task-results.yml
#   - Primera vez: crea el archivo con lab1 (ejemplo real), plantillas labN,
#     y el ejemplo de subtarea (sin bloque lab#).
#   - Siguientes veces: agrega las secciones labN faltantes (lab2, lab3, etc.)
#     sin duplicar ni modificar las existentes y colocándolas ANTES del bloque
#     comentado de subtareas.
#
# Uso:
#   1) Dar permisos de ejecución (solo la primera vez):
#        chmod +x scripts/update_task_results_yml.sh
#
#   2) Ejecutar, por ejemplo:
#        ./scripts/update_task_results_yml.sh 3
#
# ------------------------------------------------------------

set -euo pipefail

DATA_DIR="_data"
TASK_FILE="${DATA_DIR}/task-results.yml"

TOTAL_LABS="${1:-}"

if [[ -z "${TOTAL_LABS}" ]]; then
  echo "Uso: $0 <TOTAL_LABS>"
  echo "Ejemplo: $0 5"
  exit 1
fi

mkdir -p "${DATA_DIR}"

# ------------------------------------------------------------
# CASO 1: El archivo NO existe -> crear estructura base completa
# ------------------------------------------------------------
if [[ ! -f "${TASK_FILE}" ]]; then
  echo "No existe ${TASK_FILE}. Creando estructura base..."

  # Cabecera + lab1 con ejemplo real
  cat > "${TASK_FILE}" <<'EOF'
# EJEMPLO PARA LOS RESULTADOS ESPERADOS DE CADA TAREA DE CADA PRACTICA
lab1:
  results:
    # LISTA DE CADA RESULTADO DE CADA TAREA SE MOSTRARA EN COLOR VERDE PARA QUE RESALTE
    - "**Resultado esperado:** MODIFICAR AQUI EL TEXTO DE LA DESCRIPCION DEL RESULTADO ESPERADO"
    - "**Resultado esperado:** MODIFICAR AQUI EL TEXTO DE LA DESCRIPCION DEL RESULTADO ESPERADO"
EOF

  # Si TOTAL_LABS > 1, agregamos lab2..labN como plantillas genéricas
  if (( TOTAL_LABS > 1 )); then
    for i in $(seq 2 "${TOTAL_LABS}"); do
      cat >> "${TASK_FILE}" <<EOF

lab${i}:
  results:
    - "**Resultado esperado:** MODIFICAR AQUI EL TEXTO DE LA DESCRIPCION DEL RESULTADO ESPERADO"
    - "**Resultado esperado:** MODIFICAR AQUI EL TEXTO DE LA DESCRIPCION DEL RESULTADO ESPERADO"
EOF
    done
  fi

  # Solo el ejemplo de subtarea (sin bloque lab#)
  cat >> "${TASK_FILE}" <<'EOF'

# EJEMPLO DE SUBTAREA SI ES NECESARIO SINO, ELIMINAR LA SECCIÓN
# lab61:
#   results:
#     - "**Resultado esperado:** Estructura creada y lista para cargar el contenido a los archivos."
#     - "**Resultado esperado:** App y secret listos para construir imagen y desplegar."
#     - "**Resultado esperado:** Dockerfile listo para construir imagen con healthcheck."
#     - "**Resultado esperado:** Imagen `swarm-web` lista en tu host para ser usada."
#     - "**Resultado esperado:** Swarm activo y red overlay `appnet` creada."
#     - "**Resultado esperado:** Servicio `web` en marcha, accesible por `localhost:8080` y por `web:3000` desde la `appnet`."
#     - "**Resultado esperado:** Servicio actualizado gradualmente a `1.1` sin downtime perceptible."
#     - "**Resultado esperado:** 5 tareas `Running` y respuestas alternando `host` entre más réplicas."
#     - "**Resultado esperado:** Entender el estado y la configuración del servicio, y consultar logs de ejecución."
#     - "**Resultado esperado:** Host sin Swarm activo ni artefactos de la práctica."
EOF

  echo "Listo. Creado ${TASK_FILE} con lab1, labs extra y ejemplo de subtarea. TOTAL_LABS=${TOTAL_LABS}"
  exit 0
fi

# ------------------------------------------------------------
# CASO 2: El archivo YA existe -> agregar labs faltantes
# ------------------------------------------------------------

echo "${TASK_FILE} ya existe. Analizando labs existentes..."

# Encontrar número máximo de lab real (lab1, lab2, ...) ignorando comentarios
MAX_LAB_STR="$(grep -E '^[[:space:]]*lab[0-9]+:' "${TASK_FILE}" \
  | sed -E 's/^[[:space:]]*lab([0-9]+):.*/\1/' \
  | sort -n | tail -n 1 || true)"

if [[ -z "${MAX_LAB_STR}" ]]; then
  CURRENT_MAX=0
else
  CURRENT_MAX="${MAX_LAB_STR}"
fi

echo "Labs existentes (máximo): ${CURRENT_MAX}"

if (( TOTAL_LABS <= CURRENT_MAX )); then
  echo "Ya hay ${CURRENT_MAX} labs definidos y solicitaste ${TOTAL_LABS}. No se agregan nuevos."
  exit 0
fi

START_NEW=$((CURRENT_MAX + 1))

echo "Se agregarán labs desde lab${START_NEW} hasta lab${TOTAL_LABS}..."

TMP_FILE="${TASK_FILE}.tmp"

# Buscar el bloque de subtarea para insertar ANTES de ese comentario
SUBTAREA_LINE_STR="$(grep -n 'EJEMPLO DE SUBTAREA' "${TASK_FILE}" || true)"

if [[ -n "${SUBTAREA_LINE_STR}" ]]; then
  # Línea donde empieza el comentario de subtarea
  SUBTAREA_LINE="${SUBTAREA_LINE_STR%%:*}"
  # Insertar justo antes de esa línea
  INSERTION_LINE=$((SUBTAREA_LINE - 1))
  if (( INSERTION_LINE < 1 )); then
    INSERTION_LINE=$(wc -l < "${TASK_FILE}")
  fi

  # Copiar todo hasta justo antes del bloque de subtarea
  head -n "${INSERTION_LINE}" "${TASK_FILE}" > "${TMP_FILE}"

  # Agregar los nuevos labs
  for i in $(seq "${START_NEW}" "${TOTAL_LABS}"); do
    cat >> "${TMP_FILE}" <<EOF

lab${i}:
  results:
    - "**Resultado esperado:** MODIFICAR AQUI EL TEXTO DE LA DESCRIPCION DEL RESULTADO ESPERADO"
    - "**Resultado esperado:** MODIFICAR AQUI EL TEXTO DE LA DESCRIPCION DEL RESULTADO ESPERADO"
EOF
  done

  # Añadir el bloque de subtarea (comentado) y cualquier cosa que venga después
  tail -n +"${SUBTAREA_LINE}" "${TASK_FILE}" >> "${TMP_FILE}"

else
  # Si por algún motivo no existe el comentario de subtarea, agregamos al final
  cp "${TASK_FILE}" "${TMP_FILE}"

  for i in $(seq "${START_NEW}" "${TOTAL_LABS}"); do
    cat >> "${TMP_FILE}" <<EOF

lab${i}:
  results:
    - "**Resultado esperado:** MODIFICAR AQUI EL TEXTO DE LA DESCRIPCION DEL RESULTADO ESPERADO"
    - "**Resultado esperado:** MODIFICAR AQUI EL TEXTO DE LA DESCRIPCION DEL RESULTADO ESPERADO"
EOF
  done
fi

mv "${TMP_FILE}" "${TASK_FILE}"

echo "Listo. Agregados labs lab${START_NEW}..lab${TOTAL_LABS} en ${TASK_FILE}."
