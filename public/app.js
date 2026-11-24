const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

/** Builds an element. Text goes in as text, never as HTML: labels come from other apps. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "onclick") node.addEventListener("click", value);
    else if (value !== undefined) node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function svg(tag, attributes = {}, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

const money = (n, digits = 2) => {
  if (n === null) return "–";
  const sign = n < 0 ? "−" : "";
  const size = Math.abs(n);
  const smallest = 1 / 10 ** digits;
  // Too small to show: say so rather than print $0.00.
  if (size > 0 && size < smallest / 2) return `${sign}<$${smallest.toFixed(digits)}`;
  const formatted = size.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${sign}$${formatted}`;
};
/** A single AI call often costs a fraction of a cent. */
const modelMoney = (n) => money(n, 4);
const percent = (n) => (n === null ? "–" : `${Math.round(n * 100)}%`);
const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const dayLabel = (t) =>
  new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function table(columns, rows) {
  return el(
    "table",
    {},
    el(
      "thead",
      {},
      el("tr", {}, ...columns.map((c) => el("th", { scope: "col", class: c.num ? "num" : undefined }, c.title))),
    ),
    el(
      "tbody",
      {},
      ...rows.map((row) =>
        el("tr", {}, ...columns.map((c) => el("td", { class: c.num ? "num" : undefined }, c.value(row)))),
      ),
    ),
  );
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json()).error);
}

function showSummary({ summary: s }) {
  $("yield").textContent = money(s.yield);
  $("equation").textContent = `${money(s.value)} verified value − ${money(s.totalCost)} full cost`;

  const reviewed = s.outcomes - s.pending;
  const tile = (label, value, note) => el("div", {}, el("dt", {}, label), el("dd", {}, value, el("small", {}, note)));
  $("tiles").replaceChildren(
    tile("Cost per verified outcome", money(s.costPerVerified), "model, people and fixed cost"),
    tile("First-pass rate", percent(s.firstPassRate), "accepted with no fixing"),
    tile("Verified outcomes", s.verified.toLocaleString("en-US"), `of ${plural(reviewed, "reviewed outcome")}`),
    tile("Waiting for review", s.pending.toLocaleString("en-US"), "cost counted, value not yet"),
  );
}

function showNotices({ summary: s, workflows }) {
  const notices = [];
  if (s.unpricedCalls > 0) {
    notices.push(`${plural(s.unpricedCalls, "call")} had no known or believable cost, so the real cost is higher than shown.`);
  }
  const unset = workflows.filter((w) => w.valuePerOutcome === null || w.hourlyRate === null);
  if (unset.length > 0) {
    notices.push(`Set the value and hourly cost for: ${unset.map((w) => w.name).join(", ")}. Until then they count as $0.`);
  }
  $("notices").replaceChildren(...notices.map((n) => el("li", {}, n)));
}

function showCosts({ summary: s }) {
  const parts = [
    ["model", "AI models", s.modelCost],
    ["human", "People checking and fixing", s.humanCost],
    ["fixed", "Fixed costs", s.fixedCost],
  ];
  if (s.totalCost === 0) {
    $("cost-bar").replaceChildren(el("p", { class: "muted" }, "No costs in this period."));
    return;
  }
  const share = (n) => {
    const p = (n / s.totalCost) * 100;
    return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
  };
  const bar = el("div", {
    class: "segments",
    role: "img",
    "aria-label": parts.map(([, name, n]) => `${name} ${money(n)}, ${share(n)}`).join("; "),
  });
  for (const [kind, name, n] of parts) {
    if (n === 0) continue;
    const segment = el("span", { class: kind });
    segment.style.flex = `${n} 0 0`;
    hover(segment, () => [share(n), `${name}, ${money(n)}`]);
    bar.append(segment);
  }
  const legend = table(
    [
      { title: "Cost", value: ([kind, name]) => el("span", {}, el("span", { class: `swatch ${kind}` }), name) },
      { title: "USD", num: true, value: ([, , n]) => money(n) },
      { title: "Share", num: true, value: ([, , n]) => share(n) },
    ],
    parts,
  );
  legend.className = "legend";
  $("cost-bar").replaceChildren(bar, legend);
}

function tooltipAt(x, y, [strong, rest]) {
  const tip = $("tooltip");
  tip.replaceChildren(el("strong", {}, strong), el("span", {}, rest));
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(x + 14, innerWidth - box.width - 8))}px`;
  tip.style.top = `${Math.max(8, y - box.height - 10)}px`;
}
const hideTooltip = () => ($("tooltip").hidden = true);

function hover(node, content) {
  node.addEventListener("pointermove", (e) => tooltipAt(e.clientX, e.clientY, content()));
  node.addEventListener("pointerleave", hideTooltip);
}

let weeklyAsTable = false;

function showWeekly({ weekly: points }) {
  const box = $("weekly");
  $("weekly-toggle").textContent = weeklyAsTable ? "Show chart" : "Show table";
  $("weekly-toggle").setAttribute("aria-pressed", String(weeklyAsTable));

  if (points.length === 0) {
    box.replaceChildren(el("p", { class: "muted" }, "Nothing reviewed in this period."));
    return;
  }
  if (weeklyAsTable) {
    box.replaceChildren(
      table(
        [
          { title: "Week starting", value: (p) => dayLabel(p.week) },
          { title: "Reviewed", num: true, value: (p) => String(p.reviewed) },
          { title: "First-pass rate", num: true, value: (p) => percent(p.firstPassRate) },
        ],
        points,
      ),
    );
    return;
  }

  const W = 480, H = 200, L = 40, R = 44, T = 12, B = 28;
  const first = points[0].week;
  const span = points.at(-1).week - first;
  const x = (p) => (span === 0 ? (L + W - R) / 2 : L + ((p.week - first) / span) * (W - L - R));
  const y = (rate) => T + (1 - rate) * (H - T - B);

  const chart = svg("svg", {
    viewBox: `0 0 ${W} ${H}`,
    tabindex: "0",
    role: "img",
    "aria-label": `First-pass rate by week: ${points.map((p) => `${dayLabel(p.week)} ${percent(p.firstPassRate)}`).join(", ")}. Use the arrow keys to step through.`,
  });
  for (const tick of [0, 0.5, 1]) {
    chart.append(
      svg("line", { class: tick === 0 ? "axis" : "grid", x1: L, x2: W - R, y1: y(tick), y2: y(tick) }),
      svg("text", { x: L - 8, y: y(tick) + 4, "text-anchor": "end" }, percent(tick)),
    );
  }
  const last = points.at(-1);
  chart.append(svg("text", { x: x(points[0]), y: H - 6, "text-anchor": points.length === 1 ? "middle" : "start" }, dayLabel(first)));
  if (points.length > 1) chart.append(svg("text", { x: x(last), y: H - 6, "text-anchor": "end" }, dayLabel(last.week)));

  const crosshair = svg("line", { class: "axis", y1: T, y2: H - B, visibility: "hidden" });
  const marker = svg("circle", { class: "dot", r: 5, visibility: "hidden" });
  chart.append(
    crosshair,
    svg("polyline", { class: "line", points: points.map((p) => `${x(p)},${y(p.firstPassRate)}`).join(" ") }),
    svg("circle", { class: "dot", cx: x(last), cy: y(last.firstPassRate), r: 4 }),
    svg("text", { class: "end", x: x(last) + 10, y: y(last.firstPassRate) + 4 }, percent(last.firstPassRate)),
    marker,
  );

  let current = points.length - 1;
  const select = (index) => {
    current = index;
    const p = points[index];
    for (const [node, set] of [
      [crosshair, { x1: x(p), x2: x(p) }],
      [marker, { cx: x(p), cy: y(p.firstPassRate) }],
    ]) {
      for (const [key, value] of Object.entries(set)) node.setAttribute(key, value);
      node.setAttribute("visibility", "visible");
    }
    const box = chart.getBoundingClientRect();
    const scale = box.width / W;
    tooltipAt(box.left + x(p) * scale, box.top + y(p.firstPassRate) * scale, [
      percent(p.firstPassRate),
      `Week of ${dayLabel(p.week)}, ${p.reviewed} reviewed`,
    ]);
  };
  const clear = () => {
    crosshair.setAttribute("visibility", "hidden");
    marker.setAttribute("visibility", "hidden");
    hideTooltip();
  };
  chart.addEventListener("pointermove", (e) => {
    const box = chart.getBoundingClientRect();
    const at = ((e.clientX - box.left) / box.width) * W;
    const distance = points.map((p) => Math.abs(x(p) - at));
    select(distance.indexOf(Math.min(...distance)));
  });
  chart.addEventListener("pointerleave", clear);
  chart.addEventListener("focus", () => chart.matches(":focus-visible") && select(current));
  chart.addEventListener("blur", clear);
  chart.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    select(Math.max(0, Math.min(points.length - 1, current + step)));
  });
  // The latest week is usually unfinished, so its rate can rest on a handful of reviews.
  const note = el("p", { class: "muted" }, `The latest point is based on ${plural(last.reviewed, "review")}.`);
  box.replaceChildren(chart, note);
}

function showTables(data) {
  const empty = (message) => el("p", { class: "muted" }, message);

  $("models").replaceChildren(
    data.models.length === 0
      ? empty("Nothing reviewed in this period.")
      : table(
          [
            { title: "Workflow", value: (m) => m.workflow },
            { title: "Models", value: (m) => m.models },
            { title: "Reviewed", num: true, value: (m) => String(m.reviewed) },
            { title: "First-pass rate", num: true, value: (m) => percent(m.firstPassRate) },
            { title: "Model cost per verified", num: true, value: (m) => modelMoney(m.modelCostPerVerified) },
            { title: "With people's time", num: true, value: (m) => money(m.variableCostPerVerified) },
          ],
          data.models,
        ),
  );

  $("workflows").replaceChildren(
    data.workflows.length === 0
      ? empty("No workflows yet. Log an AI call from your app and it appears here.")
      : table(
          [
            { title: "Workflow", value: (w) => w.name },
            { title: "Verified", num: true, value: (w) => String(w.summary.verified) },
            { title: "First-pass rate", num: true, value: (w) => percent(w.summary.firstPassRate) },
            { title: "Cost per verified", num: true, value: (w) => money(w.summary.costPerVerified) },
            { title: "Value each", num: true, value: (w) => money(w.valuePerOutcome) },
            { title: "Yield", num: true, value: (w) => money(w.summary.yield) },
            {
              title: "",
              num: true,
              value: (w) => el("button", { type: "button", "aria-label": `Set values for ${w.name}`, onclick: () => editWorkflow(w) }, "Set values"),
            },
          ],
          data.workflows,
        ),
  );

  const total = data.summary.outcomes;
  $("outcomes-note").textContent =
    total > data.outcomes.length
      ? `Showing ${data.outcomes.length} of ${total.toLocaleString("en-US")}, those waiting for review first.`
      : "Those waiting for review come first.";
  const names = { pending: "Waiting", accepted: "Accepted", reworked: "Fixed", rejected: "Rejected" };
  $("outcomes").replaceChildren(
    data.outcomes.length === 0
      ? empty("No outcomes in this period.")
      : table(
          [
            { title: "Outcome", value: (o) => o.ref ?? o.id.slice(0, 8) },
            { title: "Workflow", value: (o) => o.workflow },
            { title: "Date", value: (o) => new Date(o.createdAt).toLocaleDateString("en-GB") },
            { title: "Calls", num: true, value: (o) => String(o.calls) },
            { title: "Model cost", num: true, value: (o) => (o.unpriced ? "Unknown" : modelMoney(o.modelCost)) },
            { title: "Result", value: (o) => names[o.status] },
            {
              title: "",
              num: true,
              value: (o) =>
                el("button", { type: "button", "aria-label": `Review ${o.ref ?? o.id}`, onclick: () => review(o) }, o.status === "pending" ? "Review" : "Change"),
            },
          ],
          data.outcomes,
        ),
  );

  $("prices").textContent = `Prices from OpenRouter, ${data.pricesFetchedAt.slice(0, 10)}. Used only when the provider doesn't report a cost.`;
}

let latest = 0;
let data = null;

async function refresh() {
  const request = ++latest;
  const query = new URLSearchParams({ days: $("days").value, workflow: $("workflow").value });
  $("main").classList.add("loading");
  try {
    const response = await fetch(`/api/report?${query}`);
    const body = await response.json();
    if (request !== latest) return; // a newer filter choice replaced this one
    if (!response.ok) throw new Error(body.error);
    data = body;
    const chosen = $("workflow").value;
    $("workflow").replaceChildren(
      el("option", { value: "" }, "All workflows"),
      ...data.workflowNames.map((n) => el("option", { value: n }, n)),
    );
    $("workflow").value = chosen;
    showNotices(data);
    showSummary(data);
    showCosts(data);
    showWeekly(data);
    showTables(data);
    $("main").hidden = false;
    $("error").hidden = true;
  } catch (error) {
    if (request !== latest) return;
    $("error").textContent = `Couldn't load the report. Is the tracker still running? (${error.message})`;
    $("error").hidden = false;
  } finally {
    if (request === latest) $("main").classList.remove("loading");
  }
}

/** Opens a dialog and saves it, keeping it open with the reason if saving fails. */
function openDialog(dialog, save) {
  const form = dialog.querySelector("form");
  const notice = form.querySelector(".notice");
  notice.hidden = true;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const submit = form.querySelector("[type=submit]");
    submit.disabled = true;
    try {
      await save(form.elements);
      dialog.close();
      await refresh();
    } catch (error) {
      notice.textContent = `Couldn't save: ${error.message}`;
      notice.hidden = false;
    } finally {
      submit.disabled = false;
    }
  };
  form.querySelector(".cancel").onclick = () => dialog.close();
  dialog.showModal();
}

function review(outcome) {
  const fields = $("review-form").elements;
  $("review-name").textContent = `${outcome.workflow}: ${outcome.ref ?? outcome.id.slice(0, 8)}`;
  fields.status.value = outcome.status;
  if (outcome.status === "pending") for (const r of fields.status) r.checked = false;
  fields.reviewMinutes.value = outcome.status === "pending" ? "" : outcome.reviewMinutes;
  fields.reworkMinutes.value = outcome.reworkMinutes;

  const update = () => {
    const accepted = fields.status.value === "accepted";
    $("rework-field").hidden = accepted;
    fields.reworkMinutes.disabled = accepted;
  };
  for (const r of fields.status) r.onchange = update;
  update();

  openDialog($("review-dialog"), () =>
    post("/api/review", {
      outcomeId: outcome.id,
      status: fields.status.value,
      reviewMinutes: Number(fields.reviewMinutes.value),
      reworkMinutes: fields.status.value === "accepted" ? 0 : Number(fields.reworkMinutes.value),
    }),
  );
}

function editWorkflow(workflow) {
  const fields = $("workflow-form").elements;
  $("workflow-name").textContent = workflow.name;
  for (const key of ["valuePerOutcome", "hourlyRate", "fixedMonthly"]) {
    fields[key].value = workflow[key] ?? "";
  }
  const optional = (input) => (input.value === "" ? null : Number(input.value));
  openDialog($("workflow-dialog"), () =>
    post("/api/workflow", {
      name: workflow.name,
      valuePerOutcome: optional(fields.valuePerOutcome),
      hourlyRate: optional(fields.hourlyRate),
      fixedMonthly: Number(fields.fixedMonthly.value),
    }),
  );
}

$("filters").addEventListener("change", refresh);
$("filters").addEventListener("submit", (e) => e.preventDefault());
$("weekly-toggle").addEventListener("click", () => {
  weeklyAsTable = !weeklyAsTable;
  showWeekly(data);
});
refresh();
