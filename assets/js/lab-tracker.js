/* =========================================================
   assets/js/lab-tracker.js

   Sincronización de progreso entre Jekyll y LabControl.

   Responsabilidades:
   - Mantener lab-progress.js como experiencia local-first.
   - Detectar cambios reales de progreso en los pasos.
   - Enviar cambios al API de LabControl.
   - Mantener una cola offline en localStorage.
   - Reintentar la cola cuando regresa la conectividad.
   - Recuperar progreso existente desde LabControl.
   - Utilizar accessToken solamente en sessionStorage.
   - Nunca almacenar refreshToken.
   ========================================================= */

(function () {
  "use strict";

  const ACCESS_TOKEN_KEY =
    "netec:participantAccessToken";

  const RETURN_URL_KEY =
    "netec:labControlReturnUrl";

  const QUEUE_PREFIX =
    "netec:trackingQueue:";

  const QUEUE_VERSION = 1;

  const PROGRESS_CHANGE_EVENT =
    "lab-progress-change";

  const PROGRESS_APPLY_EVENT =
    "lab-progress-apply";

  const PARTICIPANT_HEARTBEAT_MS =
    10 * 60 * 1000;

  let flushingQueue = false;
  let accessBlocked = false;

  /* ---------------------------------------------------------
     Utilidades
     --------------------------------------------------------- */

  function safeParse(
    value,
    fallback
  ) {
    try {
      return JSON.parse(
        value
      );
    } catch (error) {
      return fallback;
    }
  }

  function getLabRoot() {
    return document.querySelector(
      "article.lab"
    );
  }

  function isTrackingEnabled(
    root
  ) {
    return (
      root &&
      root.dataset.tracking ===
        "true"
    );
  }

  function getCourseId(
    root
  ) {
    return (
      root?.dataset.courseId ||
      null
    );
  }

  function getLabId(
    root
  ) {
    return (
      root?.dataset.labId ||
      null
    );
  }

  function getApiBaseUrl(
    root
  ) {
    const value =
      root?.dataset.trackingApi;

    if (!value) {
      return null;
    }

    return value.replace(
      /\/+$/,
      ""
    );
  }

  function getSteps(
    root
  ) {
    return Array.from(
      root.querySelectorAll(
        ".step-label[data-step-id][data-task-id]"
      )
    );
  }

  function getStepId(
    step
  ) {
    return (
      step.dataset.stepId ||
      null
    );
  }

  function getTaskId(
    step
  ) {
    return (
      step.dataset.taskId ||
      null
    );
  }

  function getAccessToken() {
    return sessionStorage.getItem(
      ACCESS_TOKEN_KEY
    );
  }

  function setAccessToken(
    token
  ) {
    if (!token) {
      return;
    }

    sessionStorage.setItem(
      ACCESS_TOKEN_KEY,
      token
    );
  }

  function removeAccessToken() {
    sessionStorage.removeItem(
      ACCESS_TOKEN_KEY
    );
  }

  /* ---------------------------------------------------------
     Capturar access token desde URL fragment
     --------------------------------------------------------- */

  function captureAccessContextFromHash() {
    const hash =
      window.location.hash;

    if (
      !hash ||
      hash.length <=
        1
    ) {
      return;
    }

    const params =
      new URLSearchParams(
        hash.substring(
          1
        )
      );

    const accessToken =
      params.get(
        "lab-access"
      );

    const returnUrl =
      params.get(
        "lab-return"
      );

    if (accessToken) {
      setAccessToken(
        accessToken
      );
    }

    if (returnUrl) {
      sessionStorage.setItem(
        RETURN_URL_KEY,
        returnUrl
      );
    }

    if (
      accessToken ||
      returnUrl
    ) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`
      );
    }
  }

  function applyLabControlNavigation() {
    /*
     * En modo demostración conservamos Atrás,
     * Siguiente y Lista General.
     *
     * La navegación oficial del participante
     * permanece sin modificaciones.
     */
    if (window.LabControlDemo?.isActive()) {
      return;
    }

    const returnUrl =
      sessionStorage.getItem(
        RETURN_URL_KEY
      );

    if (!returnUrl) {
      return;
    }

    document
      .querySelectorAll(
        ".lab-nav a.btn"
      )
      .forEach(
        link => {
          link.href =
            returnUrl;
        }
      );
  }

  /* ---------------------------------------------------------
     Cola offline
     --------------------------------------------------------- */

  function getQueueKey(
    courseId,
    labId
  ) {
    return (
      `${QUEUE_PREFIX}` +
      `${courseId}:${labId}`
    );
  }

  function createEmptyQueue() {
    return {
      version:
        QUEUE_VERSION,
      items:
        [],
      updatedAt:
        null
    };
  }

  function loadQueue(
    courseId,
    labId
  ) {
    const stored =
      localStorage.getItem(
        getQueueKey(
          courseId,
          labId
        )
      );

    if (!stored) {
      return createEmptyQueue();
    }

    const parsed =
      safeParse(
        stored,
        createEmptyQueue()
      );

    if (
      !Array.isArray(
        parsed.items
      )
    ) {
      parsed.items = [];
    }

    return parsed;
  }

  function saveQueue(
    courseId,
    labId,
    queue
  ) {
    queue.version =
      QUEUE_VERSION;

    queue.updatedAt =
      Date.now();

    localStorage.setItem(
      getQueueKey(
        courseId,
        labId
      ),
      JSON.stringify(
        queue
      )
    );
  }

  function enqueueChange(
    courseId,
    labId,
    taskId,
    stepId,
    isCompleted
  ) {
    const queue =
      loadQueue(
        courseId,
        labId
      );

    /*
     * Si ya existe un cambio pendiente para
     * el mismo step, conservamos solamente
     * su estado más reciente.
     */
    queue.items =
      queue.items.filter(
        item =>
          !(
            item.taskId ===
              taskId &&
            item.stepId ===
              stepId
          )
      );

    queue.items.push({
      taskId,
      stepId,
      isCompleted,
      queuedAt:
        Date.now()
    });

    saveQueue(
      courseId,
      labId,
      queue
    );
  }

  /* ---------------------------------------------------------
     API
     --------------------------------------------------------- */

  async function apiRequest(
    root,
    path,
    options = {}
  ) {
    const apiBaseUrl =
      getApiBaseUrl(
        root
      );

    const accessToken =
      getAccessToken();

    if (
      !apiBaseUrl ||
      !accessToken
    ) {
      return {
        available:
          false,
        response:
          null
      };
    }

    const headers = {
      ...(options.headers || {}),
      Authorization:
        `Bearer ${accessToken}`
    };

    if (
      options.body !==
      undefined
    ) {
      headers[
        "Content-Type"
      ] =
        "application/json";
    }

    let response;

    try {
      response =
        await fetch(
          `${apiBaseUrl}${path}`,
          {
            ...options,
            headers
          }
        );
    } catch (error) {
      return {
        available:
          false,
        response:
          null
      };
    }

    if (
      response.status ===
      401
    ) {
      removeAccessToken();

      return {
        available:
          false,
        unauthorized:
          true,
        response
      };
    }

    return {
      available:
        true,
      response
    };
  }

  async function keepParticipantSessionAlive(
    root
  ) {
    const result =
      await apiRequest(
        root,
        "/participant-access/me"
      );

    if (
      result.unauthorized
    ) {
      const returnUrl =
        sessionStorage.getItem(
          RETURN_URL_KEY
        );

      if (returnUrl) {
        window.location.href =
          returnUrl;
      }

      return false;
    }

    return Boolean(
      result.available &&
      result.response &&
      result.response.ok
    );
  }

  function startParticipantHeartbeat(
    root
  ) {
    window.setInterval(
      () => {
        if (
          document.visibilityState ===
          "visible"
        ) {
          void keepParticipantSessionAlive(
            root
          );
        }
      },
      PARTICIPANT_HEARTBEAT_MS
    );
  }

  function handleBlockedLab(root) {
    if (accessBlocked) return;
    accessBlocked = true;
    const courseId = getCourseId(root);
    const labId = getLabId(root);
    if (courseId && labId) {
      // A 403 is an authorization decision, NOT an offline retry.
      // Drop all changes rejected while this Lab was locked.
      saveQueue(courseId, labId, createEmptyQueue());
    }
    const notice = document.createElement("div");
    notice.setAttribute("role", "alert");
    notice.textContent = "Lab bloqueado por el instructor. Los cambios locales no autorizados no se guardarán. Regresa a Lab Control y vuelve a abrirlo cuando esté disponible.";
    notice.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;padding:15px;background:#fff1f2;color:#9f1239;font-weight:600;text-align:center;border-bottom:2px solid #fb7185";
    document.body.appendChild(notice);
    // Block further clicks on steps in a tab already open.
    document.addEventListener("click", (event) => {
      if (event.target.closest(".step-label, .step-progress-toggle, [data-step-id]")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  async function sendStep(
    root,
    item
  ) {
    const courseId =
      getCourseId(
        root
      );

    const labId =
      getLabId(
        root
      );

    if (
      !courseId ||
      !labId
    ) {
      return false;
    }

    const result =
      await apiRequest(
        root,
        "/tracking/step",
        {
          method:
            "PATCH",
          body:
            JSON.stringify({
              courseTrackingId:
                courseId,
              labTrackingId:
                labId,
              taskId:
                item.taskId,
              stepId:
                item.stepId,
              isCompleted:
                item.isCompleted
            })
        }
      );

    if (
      !result.available ||
      !result.response
    ) {
      return false;
    }

    if (result.response.status === 403) {
      handleBlockedLab(root);
      return false;
    }
    return result.response.ok;
  }

  /* ---------------------------------------------------------
     Vaciar cola offline
     --------------------------------------------------------- */

  async function flushQueue(
    root
  ) {
    if (
      flushingQueue ||
      !navigator.onLine ||
      accessBlocked
    ) {
      return false;
    }

    const courseId =
      getCourseId(
        root
      );

    const labId =
      getLabId(
        root
      );

    if (
      !courseId ||
      !labId ||
      !getAccessToken()
    ) {
      return false;
    }

    flushingQueue =
      true;

    try {
      while (true) {
        const queue =
          loadQueue(
            courseId,
            labId
          );

        if (
          queue.items.length ===
          0
        ) {
          return true;
        }

        const item =
          queue.items[0];

        const sent =
          await sendStep(
            root,
            item
          );

        if (!sent) {
          return false;
        }

        /*
         * Recargar la cola después del await.
         *
         * El usuario pudo cambiar el mismo paso mientras
         * el PATCH estaba en vuelo. Solo eliminamos el item
         * si sigue representando exactamente el estado que
         * acabamos de confirmar en el servidor.
         */
        const latestQueue =
          loadQueue(
            courseId,
            labId
          );

        latestQueue.items =
          latestQueue.items.filter(
            queuedItem =>
              !(
                queuedItem.taskId ===
                  item.taskId &&
                queuedItem.stepId ===
                  item.stepId &&
                queuedItem.isCompleted ===
                  item.isCompleted
              )
          );

        saveQueue(
          courseId,
          labId,
          latestQueue
        );
      }
    } finally {
      flushingQueue =
        false;
    }
  }

  /* ---------------------------------------------------------
     Aplicar estado confirmado por LabControl
     --------------------------------------------------------- */

  function applyServerState(
    root,
    serverLab
  ) {
    if (
      !serverLab ||
      !Array.isArray(
        serverLab.steps
      )
    ) {
      return;
    }

    const labId =
      getLabId(
        root
      );

    if (!labId) {
      return;
    }

    const completedStepIds =
      serverLab.steps
        .filter(
          item =>
            item.isCompleted
        )
        .map(
          item =>
            item.stepId
        )
        .filter(
          Boolean
        );

    document.dispatchEvent(
      new CustomEvent(
        PROGRESS_APPLY_EVENT,
        {
          detail: {
            labId,
            completedStepIds
          }
        }
      )
    );
  }

  /* ---------------------------------------------------------
     Recuperar progreso desde LabControl
     --------------------------------------------------------- */

  async function pullServerProgress(
    root
  ) {
    const result =
      await apiRequest(
        root,
        "/tracking/progress"
      );

    if (
      !result.available ||
      !result.response ||
      !result.response.ok
    ) {
      return;
    }

    let payload;

    try {
      payload =
        await result.response.json();
    } catch (error) {
      return;
    }

    if (
      !Array.isArray(
        payload.labs
      )
    ) {
      return;
    }

    const labId =
      getLabId(
        root
      );

    const serverLab =
      payload.labs.find(
        lab =>
          lab.labTrackingId ===
          labId
      );

    if (!serverLab) {
      return;
    }

    applyServerState(
      root,
      serverLab
    );
  }

  /* ---------------------------------------------------------
     Recibir cambios explícitos desde lab-progress.js
     --------------------------------------------------------- */

  function observeProgressChanges(
    root,
    steps
  ) {
    const validSteps =
      new Map(
        steps
          .map(step => [
            getStepId(
              step
            ),
            getTaskId(
              step
            )
          ])
          .filter(
            (
              [
                stepId,
                taskId
              ]
            ) =>
              stepId &&
              taskId
          )
      );

    document.addEventListener(
      PROGRESS_CHANGE_EVENT,
      event => {
        if (accessBlocked) return;
        const detail =
          event.detail;

        const courseId =
          getCourseId(
            root
          );

        const labId =
          getLabId(
            root
          );

        if (
          !detail ||
          !courseId ||
          !labId ||
          detail.labId !==
            labId ||
          !Array.isArray(
            detail.changes
          )
        ) {
          return;
        }

        detail.changes.forEach(
          change => {
            if (
              !change ||
              !change.stepId ||
              !change.taskId ||
              typeof change.isCompleted !==
                "boolean"
            ) {
              return;
            }

            /*
             * Solo aceptamos pares task/step que realmente
             * existen en el Lab renderizado.
             */
            if (
              validSteps.get(
                change.stepId
              ) !==
              change.taskId
            ) {
              return;
            }

            enqueueChange(
              courseId,
              labId,
              change.taskId,
              change.stepId,
              change.isCompleted
            );
          }
        );

        void flushQueue(
          root
        );
      }
    );
  }

  /* ---------------------------------------------------------
     Inicialización
     --------------------------------------------------------- */

  async function initLabTracker() {
    const root =
      getLabRoot();

    if (
      !root ||
      !isTrackingEnabled(
        root
      )
    ) {
      return;
    }

    const courseId =
      getCourseId(
        root
      );

    const labId =
      getLabId(
        root
      );

    const apiBaseUrl =
      getApiBaseUrl(
        root
      );

    if (
      !courseId ||
      !labId
    ) {
      console.warn(
        "Lab tracking is enabled but course_id or lab_id is missing."
      );

      return;
    }

    const steps =
      getSteps(
        root
      );

    if (
      steps.length ===
      0
    ) {
      return;
    }

    /*
     * El contexto de demostración debe permanecer
     * disponible para el almacenamiento local aislado.
     * No capturar lab-return como retorno de participante.
     */
    if (!window.LabControlDemo?.isActive()) {
      captureAccessContextFromHash();
    }

    applyLabControlNavigation();

    /*
     * El instructor usa lab-progress.js con almacenamiento
     * aislado. Nunca sincronizamos sus marcas con la API.
     */
    if (window.LabControlDemo?.isActive()) {
      /*
       * Mantener el contexto de demostración al navegar
       * entre laboratorios, sin sincronizar con la API.
       */
      window.LabControlDemo.propagateNavigation();

      /*
       * Mostrar el regreso a Lab Control exclusivamente
       * durante la demostración del instructor.
       */
      window.LabControlDemo.renderReturnLink();

      /*
       * No utilizar ni modificar tokens de participantes.
       * No iniciar tracking, heartbeat ni sincronización.
       */
      return;
    }

    observeProgressChanges(
      root,
      steps
    );

    /*
     * Sin API configurado, el laboratorio
     * continúa funcionando solamente con
     * lab-progress.js y localStorage.
     */
    if (!apiBaseUrl) {
      return;
    }

    if (
      !getAccessToken()
    ) {
      return;
    }

    startParticipantHeartbeat(
      root
    );

    /*
     * Primero enviamos cambios locales que
     * hubieran quedado pendientes.
     */
    const queueFlushed =
      await flushQueue(
        root
      );

    /*
     * Resolución de conflictos:
     *
     * 1. Los cambios locales pendientes se envían primero.
     * 2. Solo si la cola queda vacía recuperamos el estado
     *    confirmado por LabControl.
     * 3. Si la red falla, conservamos el estado local y
     *    dejamos la cola pendiente para el próximo retry.
     */
    if (queueFlushed) {
      await pullServerProgress(
        root
      );
    }

    window.addEventListener(
      "online",
      () => {
        void (
          async () => {
            const queueFlushed =
              await flushQueue(
                root
              );

            if (queueFlushed) {
              await pullServerProgress(
                root
              );
            }
          }
        )();
      }
    );

    /*
     * Cuando la pestaña vuelve a estar visible,
     * volvemos a intentar la cola pendiente.
     */
    document.addEventListener(
      "visibilitychange",
      () => {
        if (
          document.visibilityState ===
          "visible"
        ) {
          void (
            async () => {
              await keepParticipantSessionAlive(
                root
              );

              const queueFlushed =
                await flushQueue(
                  root
                );

              if (queueFlushed) {
                await pullServerProgress(
                  root
                );
              }
            }
          )();
        }
      }
    );
  }

  /* ---------------------------------------------------------
     Inicio
     --------------------------------------------------------- */

  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        void initLabTracker();
      }
    );
  } else {
    void initLabTracker();
  }
})();