/* =========================================================
   assets/js/lab-progress.js

   Progreso interactivo por pasos para prácticas Jekyll.

   Funcionalidad:
   - Detecta automáticamente .step-label dentro de article.lab
   - Clic en "Paso N." = marcar/desmarcar como completado
   - Guarda progreso por laboratorio en localStorage
   - Restaura progreso después de recargar la página
   - Calcula pasos completados y porcentaje
   - Genera panel de progreso automáticamente
   - Botón "Continuar" lleva al primer paso pendiente
   - Botón "Reiniciar" elimina solo el progreso del lab actual
   - Compatible con series a, b, c, d
   ========================================================= */

(function () {
  "use strict";

  const STORAGE_PREFIX = "netec:stepProgress:";
  const STORAGE_VERSION = 1;

  /* ---------------------------------------------------------
     Utilidades
     --------------------------------------------------------- */

  function safeParse(value, fallback) {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  function getLabRoot() {
    return document.querySelector("article.lab");
  }

  function getLabId(root) {
    if (!root) return null;

    /*
     * Primero intentamos leer un data-lab-id si en el futuro
     * decidimos añadirlo al layout.
     *
     * Por ahora usamos el pathname, que es único por laboratorio:
     * /lab1/lab1/
     * /lab2/lab2/
     */
    if (root.dataset.labId) {
      return root.dataset.labId;
    }

    const path = window.location.pathname
      .replace(/\/+$/, "")
      .replace(/^\/+/, "");

    return path || "lab";
  }

  function getStorageKey(labId) {
    return `${STORAGE_PREFIX}${labId}`;
  }

  function createEmptyState() {
    return {
      version: STORAGE_VERSION,
      completed: [],
      updatedAt: null
    };
  }

  function loadState(labId) {
    const key = getStorageKey(labId);
    const stored = localStorage.getItem(key);

    if (!stored) {
      return createEmptyState();
    }

    const parsed = safeParse(stored, createEmptyState());

    if (!Array.isArray(parsed.completed)) {
      parsed.completed = [];
    }

    return parsed;
  }

  function saveState(labId, state) {
    state.version = STORAGE_VERSION;
    state.updatedAt = Date.now();

    localStorage.setItem(
      getStorageKey(labId),
      JSON.stringify(state)
    );
  }

  function removeState(labId) {
    localStorage.removeItem(getStorageKey(labId));
  }

  function getStepId(step) {
    return step.dataset.stepId || null;
  }

  function getStepNumber(step) {
    return step.dataset.stepNumber || "";
  }

  function isCompleted(state, stepId) {
    return state.completed.includes(stepId);
  }

  function addCompleted(state, stepId) {
    if (!state.completed.includes(stepId)) {
      state.completed.push(stepId);
    }
  }

  function removeCompleted(state, stepId) {
    state.completed = state.completed.filter(
      id => id !== stepId
    );
  }

  function percentage(completed, total) {
    if (!total) return 0;
    return Math.round((completed / total) * 100);
  }

  /* ---------------------------------------------------------
     Aplicar estado visual a un paso
     --------------------------------------------------------- */

  function paintStep(step, completed) {
    const li = step.closest("li");

    step.classList.toggle(
      "step-label-completed",
      completed
    );

    step.setAttribute(
      "aria-pressed",
      completed ? "true" : "false"
    );

    step.setAttribute(
      "title",
      completed
        ? "Marcar este paso como pendiente"
        : "Marcar este paso como completado"
    );

    /*
     * El li completo recibe una clase.
     * El CSS del siguiente paso decidirá cuánto resaltarlo.
     */
    if (li) {
      li.classList.toggle(
        "step-completed",
        completed
      );
    }
  }

  /* ---------------------------------------------------------
     Crear panel de progreso
     --------------------------------------------------------- */

  function createProgressPanel(root) {
    const panel = document.createElement("aside");

    panel.className = "lab-progress";
    panel.setAttribute(
      "aria-label",
      "Progreso de la práctica"
    );

    panel.innerHTML = `
      <div class="lab-progress-header">
        <strong>Progreso</strong>
      </div>

      <div class="lab-progress-count">
        <span data-progress-completed>0</span>
        de
        <span data-progress-total>0</span>
        pasos
      </div>

      <div
        class="lab-progress-bar"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="0"
      >
        <div
          class="lab-progress-bar-fill"
          data-progress-fill
        ></div>
      </div>

      <div class="lab-progress-percent">
        <span data-progress-percent>0%</span>
      </div>

      <div class="lab-progress-actions">
        <button
          type="button"
          class="lab-progress-continue"
          data-progress-continue
          aria-label="Continuar al siguiente paso pendiente"
          title="Continuar"
        >
          →
        </button>

        <button
          type="button"
          class="lab-progress-reset"
          data-progress-reset
          aria-label="Reiniciar progreso"
          title="Reiniciar"
        >
          ↺
        </button>
      </div>
    `;

    document.body.appendChild(panel);

    return panel;
  }

  /* ---------------------------------------------------------
     Actualizar panel
     --------------------------------------------------------- */

  function updateProgressPanel(
    panel,
    state,
    steps
  ) {
    const total = steps.length;

    const validIds = steps
      .map(getStepId)
      .filter(Boolean);

    /*
     * Solo contamos IDs que todavía existen
     * en el documento actual.
     */
    const completedCount = validIds.filter(
      id => state.completed.includes(id)
    ).length;

    const percent = percentage(
      completedCount,
      total
    );

    const completedEl = panel.querySelector(
      "[data-progress-completed]"
    );

    const totalEl = panel.querySelector(
      "[data-progress-total]"
    );

    const percentEl = panel.querySelector(
      "[data-progress-percent]"
    );

    const fillEl = panel.querySelector(
      "[data-progress-fill]"
    );

    const progressBar = panel.querySelector(
      ".lab-progress-bar"
    );

    const continueBtn = panel.querySelector(
      "[data-progress-continue]"
    );

    if (completedEl) {
      completedEl.textContent = completedCount;
    }

    if (totalEl) {
      totalEl.textContent = total;
    }

    if (percentEl) {
      percentEl.textContent = `${percent}%`;
    }

    if (fillEl) {
      if (window.matchMedia("(min-width: 1181px)").matches) {
        fillEl.style.width = "100%";
        fillEl.style.height = `${percent}%`;
      } else {
        fillEl.style.height = "100%";
        fillEl.style.width = `${percent}%`;
      }
    }

    if (progressBar) {
      progressBar.setAttribute(
        "aria-valuenow",
        String(percent)
      );
    }

    /*
     * Si todos los pasos están completos,
     * cambiamos el texto del botón.
     */
    if (continueBtn) {
      if (
        total > 0 &&
        completedCount === total
      ) {
        continueBtn.textContent = "✓";
        continueBtn.disabled = true;
        continueBtn.title = "Práctica completada";
        continueBtn.setAttribute(
          "aria-label",
          "Práctica completada"
        );
      } else {
        continueBtn.textContent = "→";
        continueBtn.disabled = false;
        continueBtn.title = "Continuar";
        continueBtn.setAttribute(
          "aria-label",
          "Continuar al siguiente paso pendiente"
        );
      }
    }

    panel.classList.toggle(
      "is-complete",
      total > 0 &&
      completedCount === total
    );
    /*
    * ---------------------------------------------------------
    * Estado visual secuencial de los pasos
    * ---------------------------------------------------------
    */

    let firstPendingFound = false;

    steps.forEach((step) => {
      const stepId = getStepId(step);
      const li = step.closest("li");

      if (!stepId || !li) return;

      const completed =
        state.completed.includes(stepId);

      /*
      * Limpiar estados anteriores
      */
      li.classList.remove(
        "step-completed",
        "step-current",
        "step-pending"
      );

      /*
      * Paso completado
      */
      if (completed) {
        li.classList.add("step-completed");
        return;
      }

      /*
      * Primer paso pendiente = paso actual/siguiente
      */
      if (!firstPendingFound) {
        li.classList.add("step-current");
        firstPendingFound = true;
        return;
      }

      /*
      * Resto de pasos
      */
      li.classList.add("step-pending");
    });
  }

  /* ---------------------------------------------------------
     Buscar primer paso pendiente
     --------------------------------------------------------- */

  function findFirstPendingStep(
    steps,
    state
  ) {
    return steps.find(step => {
      const id = getStepId(step);

      return (
        id &&
        !state.completed.includes(id)
      );
    });
  }

  /* ---------------------------------------------------------
     Scroll al paso pendiente
     --------------------------------------------------------- */

  function scrollToStep(step) {
    if (!step) return;

    const li = step.closest("li") || step;

    li.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });

    /*
     * Dar foco al marcador para que también
     * funcione bien con teclado.
     */
    window.setTimeout(() => {
      step.focus({
        preventScroll: true
      });
    }, 400);
  }

  function avoidFooterOverlap(panel) {
    if (window.matchMedia("(min-width: 1181px)").matches) {
      panel.style.removeProperty("top");
      panel.style.removeProperty("bottom");
      return;
    }
    const footerNav =
      document.querySelector(".lab-nav-wrap-bottom") ||
      document.querySelector(".lab-nav.bottom");

    if (!panel || !footerNav) return;

    const footerRect = footerNav.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const safeGap = 12;

    /*
    * Distancia desde la parte superior del footer
    * hasta el borde inferior del viewport.
    */
    const overlap = viewportHeight - footerRect.top;

    if (overlap > 0) {
      /*
      * IMPORTANTE:
      * Si utilizamos bottom, debemos eliminar top.
      * De lo contrario, position:fixed intenta ocupar
      * todo el espacio entre top y bottom y el panel
      * se estira verticalmente.
      */
      panel.style.top = "auto";
      panel.style.bottom = `${overlap + safeGap}px`;
    } else {
      /*
      * Al alejarnos del footer eliminamos los estilos
      * inline y dejamos que el CSS responsive decida:
      *
      * Escritorio:
      *   top: 120px;
      *   bottom: auto;
      *
      * Tablet/móvil:
      *   top: auto;
      *   bottom: 12px / 6px;
      */
      panel.style.removeProperty("top");
      panel.style.removeProperty("bottom");
    }
  }
  /* ---------------------------------------------------------
     Inicialización principal
     --------------------------------------------------------- */
/* ---------------------------------------------------------
   Notificación ligera de progreso
   --------------------------------------------------------- */

  function showProgressNotice(message, type = "info") {
    let notice = document.querySelector(".lab-progress-notice");

    if (!notice) {
      notice = document.createElement("div");
      notice.className = "lab-progress-notice";
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");

      document.body.appendChild(notice);
    }

    notice.classList.remove(
      "is-visible",
      "is-forward",
      "is-backward"
    );

    if (type === "forward") {
      notice.classList.add("is-forward");
    }

    if (type === "backward") {
      notice.classList.add("is-backward");
    }

    notice.textContent = message;

    /*
    * Forzar reflow para reiniciar la animación
    * cuando se hacen varios clics seguidos.
    */
    void notice.offsetWidth;

    notice.classList.add("is-visible");

    clearTimeout(notice._hideTimer);

    notice._hideTimer = window.setTimeout(() => {
      notice.classList.remove("is-visible");
    }, 2400);
  }

  function initLabProgress() {
    const root = getLabRoot();

    if (!root) {
      return;
    }

    const steps = Array.from(
      root.querySelectorAll(
        ".step-label[data-step-id]"
      )
    );

    /*
     * Si una página lab no tiene pasos,
     * no mostramos el panel.
     */
    if (!steps.length) {
      return;
    }

    const labId = getLabId(root);

    if (!labId) {
      return;
    }

    let state = loadState(labId);

    const panel =
      createProgressPanel(root);

    avoidFooterOverlap(panel);

    window.addEventListener(
      "scroll",
      () => avoidFooterOverlap(panel),
      { passive: true }
    );

    window.addEventListener(
      "resize",
      () => avoidFooterOverlap(panel)
    );
    /* -------------------------------------------------------
       Restaurar estado guardado
       ------------------------------------------------------- */

    steps.forEach(step => {
      const stepId = getStepId(step);

      if (!stepId) return;

      paintStep(
        step,
        isCompleted(
          state,
          stepId
        )
      );
    });

    updateProgressPanel(
      panel,
      state,
      steps
    );

    /* -------------------------------------------------------
       Alternar un paso
       ------------------------------------------------------- */

    function toggleStep(step) {
      const clickedId = getStepId(step);

      if (!clickedId) return;

      state = loadState(labId);

      /*
      * Índice del paso seleccionado dentro de la secuencia
      * real del laboratorio.
      */
      const clickedIndex = steps.indexOf(step);

      if (clickedIndex === -1) return;

      /*
      * Averiguar hasta qué paso existe progreso continuo.
      *
      * Ejemplo:
      * completados = Paso 1, Paso 2, Paso 3
      *
      * currentCompletedIndex = 2
      */
      let currentCompletedIndex = -1;

      for (let i = 0; i < steps.length; i++) {
        const id = getStepId(steps[i]);

        if (
          id &&
          state.completed.includes(id)
        ) {
          currentCompletedIndex = i;
        } else {
          break;
        }
      }

      /*
      * CASO A
      * El usuario hace clic en un paso pendiente.
      *
      * Se marcará automáticamente ese paso y todos
      * los anteriores que todavía estén pendientes.
      */
      if (clickedIndex > currentCompletedIndex) {

        const previousIndex =
          currentCompletedIndex;

        for (
          let i = 0;
          i <= clickedIndex;
          i++
        ) {
          const id = getStepId(steps[i]);

          if (!id) continue;

          addCompleted(state, id);

          paintStep(
            steps[i],
            true
          );
        }

        saveState(
          labId,
          state
        );

        updateProgressPanel(
          panel,
          state,
          steps
        );

        /*
        * Si avanzó solamente un paso:
        */
        if (
          clickedIndex ===
          previousIndex + 1
        ) {
          showProgressNotice(
            `Paso ${clickedIndex + 1} completado`,
            "forward"
          );
        } else {
          /*
          * Si saltó varios pasos:
          */
          showProgressNotice(
            `Avance actualizado hasta el Paso ${clickedIndex + 1}`,
            "forward"
          );
        }

        return;
      }

      /*
      * CASO B
      * El usuario hace clic sobre un paso ya completado.
      *
      * Ese paso y todos los posteriores vuelven
      * al estado pendiente.
      */
      if (clickedIndex <= currentCompletedIndex) {

        for (
          let i = clickedIndex;
          i < steps.length;
          i++
        ) {
          const id = getStepId(steps[i]);

          if (!id) continue;

          removeCompleted(state, id);

          paintStep(
            steps[i],
            false
          );
        }

        saveState(
          labId,
          state
        );

        updateProgressPanel(
          panel,
          state,
          steps
        );

        if (clickedIndex === 0) {
          showProgressNotice(
            "Progreso reiniciado desde el Paso 1",
            "backward"
          );
        } else {
          showProgressNotice(
            `Progreso regresado al Paso ${clickedIndex}`,
            "backward"
          );
        }
      }
    }

    /* -------------------------------------------------------
       Eventos de clic
       ------------------------------------------------------- */

    steps.forEach(step => {
      step.addEventListener(
        "click",
        event => {
          event.preventDefault();

          toggleStep(step);
        }
      );

      /*
       * Accesibilidad:
       * Enter o Espacio también marcan/desmarcan.
       */
      step.addEventListener(
        "keydown",
        event => {
          if (
            event.key === "Enter" ||
            event.key === " "
          ) {
            event.preventDefault();

            toggleStep(step);
          }
        }
      );
    });

    /* -------------------------------------------------------
       Botón Continuar
       ------------------------------------------------------- */

    const continueBtn =
      panel.querySelector(
        "[data-progress-continue]"
      );

    if (continueBtn) {
      continueBtn.addEventListener(
        "click",
        () => {
          state = loadState(labId);

          const pending =
            findFirstPendingStep(
              steps,
              state
            );

          if (pending) {
            scrollToStep(pending);
          }
        }
      );
    }

    /* -------------------------------------------------------
       Botón Reiniciar
       ------------------------------------------------------- */

    const resetBtn =
      panel.querySelector(
        "[data-progress-reset]"
      );

    if (resetBtn) {
      resetBtn.addEventListener(
        "click",
        () => {
          const confirmed =
            window.confirm(
              "¿Deseas borrar el progreso de esta práctica?"
            );

          if (!confirmed) {
            return;
          }

          removeState(labId);

          state =
            createEmptyState();

          steps.forEach(step => {
            paintStep(
              step,
              false
            );
          });

          updateProgressPanel(
            panel,
            state,
            steps
          );

          /*
           * Volver al primer paso después
           * de reiniciar.
           */
          if (steps[0]) {
            scrollToStep(
              steps[0]
            );
          }
        }
      );
    }
  }

  /* ---------------------------------------------------------
     Inicio
     --------------------------------------------------------- */

  if (
    document.readyState === "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      initLabProgress
    );
  } else {
    initLabProgress();
  }
})();