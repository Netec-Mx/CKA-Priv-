document.addEventListener("DOMContentLoaded", function () {
  const content =
    document.querySelector(".lab-content") ||
    document.querySelector("article") ||
    document.querySelector("main");

  if (!content) return;

  const tables = content.querySelectorAll("table");

  tables.forEach(function (table) {
    if (table.closest(".highlight, pre, code")) return;
    if (table.closest(".lab-table-wrap")) return;

    const wrapper = document.createElement("div");
    wrapper.className = "lab-table-wrap";

    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);

    const headers = Array.from(table.querySelectorAll("thead th"));
    const rows = table.querySelectorAll("tbody tr");

    headers.forEach(function (th, index) {
      const text = th.textContent.trim().toLowerCase();

      if (
        text === "completado" ||
        text === "puntos" ||
        text.includes("cp/ap")
      ) {
        th.classList.add("lab-check-cell");
      }

      rows.forEach(function (row) {
        const cell = row.children[index];
        if (!cell) return;

        const cellText = cell.textContent.trim();

        if (
          text === "completado" ||
          cell.querySelector('input[type="checkbox"]')
        ) {
          cell.classList.add("lab-check-cell");
        }

        if (cellText === "" || cellText === "\u00a0") {
          cell.classList.add("lab-empty-cell");
          cell.innerHTML = "";
        }

        if (cellText === "☐") {
          cell.classList.add("lab-check-cell");
          cell.innerHTML = '<input type="checkbox" disabled>';
        }
      });
    });
  });
});