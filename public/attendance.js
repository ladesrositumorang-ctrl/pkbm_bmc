(() => {
  const form = document.getElementById("roll-form");
  if (!form) return;
  const rows = [...form.querySelectorAll(".roll-row")];
  const counter = document.getElementById("pending-count");
  const markAll = document.getElementById("mark-all-present");

  const pendingRows = () =>
    rows.filter((row) => !row.querySelector('input[type="radio"]:checked'));

  function refresh() {
    const pending = pendingRows();
    counter.textContent = pending.length;
    rows.forEach((row) =>
      row.classList.toggle("is-pending", pending.includes(row)),
    );
    markAll.disabled = pending.length === 0;
  }

  markAll.addEventListener("click", () => {
    pendingRows().forEach((row) => {
      row.querySelector('input[value="hadir"]').checked = true;
    });
    refresh();
  });
  form.addEventListener("change", refresh);
  refresh();
})();
