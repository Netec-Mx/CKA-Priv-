/*
 * Lab Control - Instructor demo context.
 *
 * Aísla las marcas locales del instructor.
 * No modifica las sesiones ni los tokens de participantes.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "netec:instructorDemoSession";
  const RETURN_PREFIX = "netec:instructorDemoReturnUrl:";

  /*
   * Este valor se obtiene de site.labcontrol_api_url,
   * mediante el layout de Jekyll.
   */
  function getAllowedOrigin() {
    const root = document.querySelector(
      "article.lab[data-tracking-api]"
    );

    const apiUrl = root?.dataset.trackingApi;

    if (!apiUrl) {
      return null;
    }

    try {
      const parsed = new URL(apiUrl);
      return parsed.protocol === "https:"
        ? parsed.origin
        : null;
    } catch {
      return null;
    }
  }

  function readContext() {
    const params = new URLSearchParams(
      window.location.hash.slice(1)
    );

    const sessionId = params.get("lab-demo");

    if (sessionId) {
      sessionStorage.setItem(STORAGE_KEY, sessionId);

      const returnUrl = params.get("lab-return");

      if (returnUrl) {
        try {
          const url = new URL(returnUrl);

          const allowedOrigin = getAllowedOrigin();

          if (
            allowedOrigin &&
            url.origin === allowedOrigin &&
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            url.pathname === "/participant" &&
            url.searchParams.get("instructorSession") === sessionId
          ) {
            sessionStorage.setItem(
              RETURN_PREFIX + sessionId,
              url.toString()
            );
          }
        } catch {
          console.warn("URL de regreso de demostración inválida.");
        }
      }

      return sessionId;
    }

    if (params.has("lab-access")) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }

    /*
     * Una navegación normal sin lab-demo no debe activar
     * una demostración anterior. El contexto explícito
     * será propagado solamente por los enlaces de prueba.
     */
    return null;
  }

  function propagateNavigation() {
    const sessionId = readContext();

    if (!sessionId) {
      return;
    }

    document.querySelectorAll(
      ".lab-nav a.btn"
    ).forEach(link => {
      const url = new URL(
        link.href,
        window.location.href
      );

      if (url.origin !== window.location.origin) {
        return;
      }

      const params = new URLSearchParams(
        url.hash.slice(1)
      );

      params.set("lab-demo", sessionId);

      url.hash = params.toString();
      link.href = url.toString();
    });
  }

  function renderReturnLink() {
    const returnUrl = window.LabControlDemo.getReturnUrl();

    if (!returnUrl) {
      return;
    }

    const root = document.querySelector("article.lab");

    if (!root || document.getElementById("instructor-demo-return")) {
      return;
    }

    const container = document.createElement("div");
    container.id = "instructor-demo-return";
    container.style.margin = "16px 0";
    container.style.padding = "12px";
    container.style.border = "1px solid #d97706";
    container.style.borderRadius = "8px";

    const message = document.createElement("span");
    message.textContent = "Vista de prueba del instructor · ";
    message.style.marginRight = "12px";

    const link = document.createElement("a");
    link.href = returnUrl;
    link.textContent = "Volver a Lab Control";
    link.className = "btn";

    container.append(message, link);
    root.prepend(container);
  }

  window.LabControlDemo = {
    renderReturnLink,
    propagateNavigation,
    getReturnUrl: function () {
      const sessionId = readContext();

      if (!sessionId) {
        return null;
      }

      return sessionStorage.getItem(
        RETURN_PREFIX + sessionId
      );
    },
    getSessionId: readContext,
    isActive: function () {
      return Boolean(readContext());
    },
    getProgressKey: function (courseId, labId) {
      const sessionId = readContext();

      if (!sessionId) {
        return null;
      }

      return [
        "netec:instructorDemoProgress",
        sessionId,
        courseId || "legacy",
        labId
      ].join(":");
    }
  };
})();
