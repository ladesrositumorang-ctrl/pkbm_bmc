(() => {
  const stage = document.querySelector(".chart-stage:not(.chart-empty-stage)");
  if (!stage) return;

  const tooltip = stage.querySelector(".chart-tooltip");
  const title = tooltip.querySelector(".chart-tooltip-title");
  const statusList = tooltip.querySelector(".chart-tooltip-statuses");
  const total = tooltip.querySelector(".chart-tooltip-total strong");
  const columns = stage.querySelectorAll(".chart-column");
  let activeColumn = null;

  function positionTooltip(column, event) {
    const stageRect = stage.getBoundingClientRect();
    const columnRect = column.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const anchorX = event ? event.clientX : columnRect.left + columnRect.width / 2;
    const anchorY = event ? event.clientY : columnRect.top;
    const minimumLeft = Math.min(tooltipWidth / 2 + 8, stageRect.width / 2);
    const maximumLeft = Math.max(
      minimumLeft,
      stageRect.width - tooltipWidth / 2 - 8,
    );
    const left = Math.min(
      maximumLeft,
      Math.max(minimumLeft, anchorX - stageRect.left),
    );
    const top = Math.min(
      Math.max(anchorY - stageRect.top - tooltipHeight - 12, 8),
      Math.max(8, stageRect.height - tooltipHeight - 8),
    );

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function showTooltip(column, event) {
    activeColumn = column;
    title.textContent = column.dataset.tooltipTitle;
    total.textContent = column.dataset.tooltipTotal;
    statusList.replaceChildren();

    const statuses = JSON.parse(column.dataset.tooltipStatuses);
    statuses.forEach((status) => {
      const item = document.createElement("li");
      const dot = document.createElement("span");
      const label = document.createElement("span");
      const count = document.createElement("strong");

      dot.className = "tooltip-status-dot";
      dot.style.backgroundColor = status.color;
      dot.setAttribute("aria-hidden", "true");
      label.textContent = status.label;
      count.textContent = status.count;
      item.append(dot, label, count);
      statusList.append(item);
    });

    tooltip.hidden = false;
    positionTooltip(column, event);
  }

  columns.forEach((column) => {
    column.addEventListener("pointerenter", (event) =>
      showTooltip(column, event),
    );
    column.addEventListener("pointermove", (event) => {
      if (activeColumn === column) positionTooltip(column, event);
    });
    column.addEventListener("pointerleave", () => {
      if (document.activeElement !== column) {
        tooltip.hidden = true;
        activeColumn = null;
      }
    });
    column.addEventListener("focus", () => showTooltip(column));
    column.addEventListener("blur", () => {
      tooltip.hidden = true;
      activeColumn = null;
    });
  });
})();
