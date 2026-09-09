// assets/js/image-zoom.js
// Zoom solo para imágenes dentro de la sección .lab-instructions
(function () {
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    // Cada página de lab tiene un <article class="lab">; limitamos el alcance ahí.
    var labArticle = document.querySelector("article.lab");
    if (!labArticle) return;

    var scope = labArticle.querySelector(".lab-instructions");
    if (!scope) return;

    var modal = document.getElementById("imgModal");
    var modalImg = document.getElementById("imgZoom");
    // var caption = document.getElementById("imgCaption"); caption
    var closeBtn = modal ? modal.querySelector(".img-close") : null;
    // if (!modal || !modalImg || !caption || !closeBtn) return; caption
    if (!modal || !modalImg || !closeBtn) return;

    // Cursor visual de zoom
    scope.querySelectorAll("img").forEach(function (img) {
      img.style.cursor = "zoom-in";
    });

    // Delegación de eventos (sirve aunque el HTML venga de markdownify)
    scope.addEventListener("click", function (e) {
      var img = e.target.closest("img");
      if (!img || !scope.contains(img)) return;

      // Si la imagen tiene data-zoom-src, se usa esa (útil para alta resolución)
      var src = img.getAttribute("data-zoom-src") || img.src;

      modal.style.display = "block";
      modal.setAttribute("aria-hidden", "false");
      modalImg.src = src;
      modalImg.alt = img.alt || "";
      // caption.textContent = img.alt || ""; caption
    });

    function closeModal() {
      modal.style.display = "none";
      modal.setAttribute("aria-hidden", "true");
      modalImg.src = "";
    }

    closeBtn.addEventListener("click", closeModal);
    modal.addEventListener("click", function (e) {
      if (e.target === modal) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
    });
  });
})();
