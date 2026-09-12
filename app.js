"use strict";

const state = {
  bills: [],
  topics: [],
  sessions: [],
  changes: [],
  meta: {},
  filtered: [],
  visible: 30,
  topicLabels: new Map()
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function text(value) {
  return value == null || value === "" ? "Not listed" : String(value);
}

function formatDate(value, withTime = false) {
  if (!value) return "Not listed";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" } : {})
  }).format(date);
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

async function loadJson(path, fallback) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } catch (error) {
    console.warn(`Could not load ${path}`, error);
    return fallback;
  }
}

async function initialize() {
  const [bills, topics, changes, meta, sessions] = await Promise.all([
    loadJson("data/bills.json", []),
    loadJson("data/topics.json", []),
    loadJson("data/changes.json", []),
    loadJson("data/meta.json", {}),
    loadJson("data/sessions.json", [])
  ]);
  state.bills = bills;
  state.topics = topics;
  state.changes = changes;
  state.meta = meta;
  state.sessions = sessions;
  state.topicLabels = new Map(topics.map((topic) => [topic.id, topic.label]));

  renderMeta();
  renderInterests();
  populateFilters();
  populateSessions();
  populateLetterBills();
  renderBills();
  renderChanges();
  bindEvents();
  applyDeepLink();
}

function renderMeta() {
  setText("#session-label", state.meta.session_label || "Maryland Regular Session");
  setText("#bill-count", state.meta.bill_count ?? state.bills.length);
  setText("#updated-at", formatDate(state.meta.updated_at, true));
  const time = $("#updated-at");
  if (time && state.meta.updated_at) time.dateTime = state.meta.updated_at;
}

function renderInterests() {
  const grid = $("#interest-grid");
  grid.replaceChildren();
  state.topics.filter((topic) => topic.id !== "other").forEach((topic) => {
    const label = document.createElement("label");
    label.className = "interest-card";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "topics";
    input.value = topic.id;
    const content = document.createElement("span");
    content.className = "interest-card-content";
    const heading = document.createElement("strong");
    heading.textContent = topic.label;
    const description = document.createElement("small");
    description.textContent = topic.description;
    content.append(heading, description);
    label.append(input, content);
    grid.append(label);
  });
}

function populateFilters() {
  const select = $("#topic-filter");
  state.topics.forEach((topic) => {
    const option = document.createElement("option");
    option.value = topic.id;
    option.textContent = topic.label;
    select.append(option);
  });
}

function populateSessions() {
  const select = $("#session-filter");
  state.sessions.forEach((session) => {
    if (session.current) return;
    const option = document.createElement("option");
    option.value = session.session;
    option.textContent = session.session_label;
    select.append(option);
  });
}

function selectedInterestIds() {
  return new Set(
    $$('#subscription-form input[name="topics"]:checked').map((input) => input.value)
  );
}

function populateLetterBills(preferredBillId = "") {
  const select = $("#letter-bill");
  const selectedTopics = selectedInterestIds();
  const matchingBills = selectedTopics.size
    ? state.bills.filter((bill) =>
        (bill.topics || []).some((topic) => selectedTopics.has(topic))
      )
    : [];
  const prompt = selectedTopics.size
    ? `Choose from ${matchingBills.length.toLocaleString()} matching bills`
    : "Select your interests above to see bills";
  select.replaceChildren(new Option(prompt, ""));
  matchingBills.forEach((bill) => {
    const option = document.createElement("option");
    option.value = bill.id;
    option.textContent = `${bill.bill_number} â€” ${bill.title}`;
    select.append(option);
  });
  select.disabled = matchingBills.length === 0;
  if (preferredBillId && matchingBills.some((bill) => bill.id === preferredBillId)) {
    select.value = preferredBillId;
  }
}

async function switchSession() {
  const value = $("#session-filter").value;
  const selected = value
    ? state.sessions.find((session) => session.session === value)
    : state.sessions.find((session) => session.current);
  if (!selected) return;
  const [bills, changes] = await Promise.all([
    loadJson(selected.bills_path, []),
    loadJson(selected.changes_path, [])
  ]);
  state.bills = bills;
  state.changes = changes;
  setText("#session-label", selected.session_label);
  setText("#bill-count", bills.length.toLocaleString());
  populateLetterBills();
  renderBills();
  $("#change-list").replaceChildren();
  renderChanges();
}

function searchableText(bill) {
  return [
    bill.bill_number, bill.title, bill.synopsis, bill.sponsor, bill.status,
    ...(bill.broad_subjects || []), ...(bill.narrow_subjects || [])
  ].join(" ").toLowerCase();
}

function billMatches(bill) {
  const query = $("#bill-search").value.trim().toLowerCase();
  const topic = $("#topic-filter").value;
  const chamber = $("#chamber-filter").value;
  const status = $("#status-filter").value;
  if (query && !searchableText(bill).includes(query)) return false;
  if (topic && !(bill.topics || []).includes(topic)) return false;
  if (chamber && !bill.bill_number.startsWith(chamber)) return false;
  if (status === "hearing" && !(bill.hearings || []).length) return false;
  if (status === "passed" && !bill.passed_by_mga) return false;
  if (status === "governor" && !/governor|chapter|veto/i.test(bill.status || "")) return false;
  return true;
}

function detailRow(list, term, description) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = description;
  list.append(dt, dd);
}

function renderBillCard(bill) {
  const node = $("#bill-card-template").content.firstElementChild.cloneNode(true);
  node.dataset.billId = bill.id;
  node.querySelector(".bill-number").textContent = bill.bill_number;
  node.querySelector(".version-pill").textContent = bill.bill_version ? `Version ${bill.bill_version}` : "";
  node.querySelector(".bill-title").textContent = bill.title;
  node.querySelector(".bill-status").textContent = bill.status;
  const generated = bill.ai_summary;
  node.querySelector(".bill-summary").textContent = generated?.plain_language_summary || bill.synopsis;

  const tags = node.querySelector(".topic-tags");
  (bill.topics || []).slice(0, 3).forEach((topicId) => {
    const tag = document.createElement("span");
    tag.className = "topic-tag";
    tag.textContent = state.topicLabels.get(topicId) || topicId;
    tags.append(tag);
  });

  const details = node.querySelector(".bill-details");
  detailRow(details, "Sponsor", text(bill.sponsor));
  detailRow(details, "Committee", (bill.committees || []).join("; ") || "Not listed");
  detailRow(details, "Hearing", (bill.hearings || []).map((date) => formatDate(date, true)).join("; ") || "Not scheduled");
  detailRow(details, "Cross-file", text(bill.crossfile_bill_number));
  detailRow(details, "Official subjects", [...(bill.broad_subjects || []), ...(bill.narrow_subjects || [])].join("; ") || "Not listed");
  if (generated) {
    detailRow(details, "AI summary", `Generated ${formatDate(generated.generated_at, true)}; human reviewed: ${generated.human_reviewed ? "yes" : "no"}`);
  }

  const link = node.querySelector(".official-link");
  link.href = bill.details_url;
  node.querySelector(".write-button").addEventListener("click", () => selectBillForLetter(bill.id));
  return node;
}

function renderBills(reset = true) {
  if (reset) state.visible = 30;
  state.filtered = state.bills.filter(billMatches);
  const list = $("#bill-list");
  list.replaceChildren(...state.filtered.slice(0, state.visible).map(renderBillCard));
  setText("#results-count", `${state.filtered.length.toLocaleString()} matching bills and resolutions`);
  const more = $("#load-more");
  more.hidden = state.visible >= state.filtered.length;
}

function shortValue(value) {
  if (Array.isArray(value)) return value.join("; ") || "none";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return text(value);
}

function renderChanges() {
  const list = $("#change-list");
  if (!state.changes.length) {
    list.innerHTML = "<p>No changes have been recorded yet. The first successful run establishes the baseline.</p>";
    return;
  }
  state.changes.slice(0, 40).forEach((change) => {
    const item = document.createElement("article");
    item.className = "change-item";
    const title = document.createElement("h3");
    const link = document.createElement("a");
    link.href = change.details_url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `${change.bill_number}: ${change.field_label}`;
    title.append(link);
    const description = document.createElement("p");
    description.textContent = change.change_type === "new_bill"
      ? `New bill: ${change.title}`
      : `${shortValue(change.old_value)} â†’ ${shortValue(change.new_value)}`;
    const date = document.createElement("p");
    date.className = "change-date";
    date.textContent = `Detected ${formatDate(change.observed_at, true)}`;
    item.append(title, description, date);
    list.append(item);
  });
}

function currentLetterBill() {
  return state.bills.find((bill) => bill.id === $("#letter-bill").value);
}

function recipientFor(bill, audience) {
  if (audience === "committee") {
    return bill.committees?.length ? `Chair and Members of the ${bill.committees[0]} Committee` : "Chair and Members of the Assigned Committee";
  }
  if (audience === "governor") return "Governor of Maryland";
  return "My Maryland Senator and Delegates";
}

function positionLanguage(position) {
  return {
    "FAVORABLE": ["in support of", "issue a favorable report"],
    "UNFAVORABLE": ["in opposition to", "issue an unfavorable report"],
    "FAVORABLE WITH AMENDMENTS": ["in support of amendments to", "consider amendments before issuing a favorable report"],
    "INFORMATION ONLY": ["to provide information concerning", "consider this information during your review"]
  }[position];
}

function generateLetter() {
  const bill = currentLetterBill();
  if (!bill) {
    $("#letter-preview").value = "Please choose a bill first.";
    return;
  }
  const position = $("#letter-position").value;
  const audience = $("#letter-audience").value;
  const name = $("#letter-name").value.trim() || "[Your name]";
  const reason = $("#letter-reason").value.trim();
  const [stance, request] = positionLanguage(position);
  const recipient = recipientFor(bill, audience);
  const committeeLine = bill.committees?.length ? `\nAssigned committee: ${bill.committees.join("; ")}` : "";
  const hearingLine = bill.hearings?.length ? `\nHearing: ${bill.hearings.map((date) => formatDate(date, true)).join("; ")}` : "";
  const personal = reason
    ? `\n\nMy reason for writing is: ${reason}`
    : "\n\n[Add a personal explanation of how this proposal affects you, your family, your work, or your community.]";

  $("#letter-preview").value = `${new Date().toLocaleDateString("en-US", { dateStyle: "long" })}

Dear ${recipient}:

RE: ${bill.bill_number} â€” ${bill.title}
Position: ${position}${committeeLine}${hearingLine}

I am writing ${stance} ${bill.bill_number}.

According to the Maryland General Assembly's official synopsis, ${bill.synopsis}${personal}

I respectfully ask that you ${request}. Thank you for considering my position and for your service to Maryland.

Sincerely,

${name}
[Street address]
[City, Maryland ZIP]
[Email or telephone, if desired]

Source checked: ${bill.details_url}
Bill data version: ${bill.bill_version || "not listed"}
`;
}

function selectBillForLetter(id) {
  const selectedBill = state.bills.find((bill) => bill.id === id);
  if (!selectedBill) return;
  if (![...$("#letter-bill").options].some((option) => option.value === id)) {
    const option = new Option(`${selectedBill.bill_number} â€” ${selectedBill.title}`, id);
    $("#letter-bill").append(option);
  }
  $("#letter-bill").disabled = false;
  $("#letter-bill").value = id;
  generateLetter();
  history.replaceState(null, "", `?action=${encodeURIComponent(id.split(":")[1])}#take-action`);
  $("#take-action").scrollIntoView({ behavior: "smooth" });
  $("#letter-position").focus({ preventScroll: true });
}

async function copyLetter() {
  const preview = $("#letter-preview");
  if (!preview.value) generateLetter();
  try {
    await navigator.clipboard.writeText(preview.value);
    const button = $("#copy-letter");
    const original = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = original; }, 1600);
  } catch {
    preview.select();
    document.execCommand("copy");
  }
}

async function submitSubscription(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = $("#subscription-status");
  const config = window.MLW_CONFIG || {};
  const topics = $$('input[name="topics"]:checked').map((input) => input.value);
  const events = $$('input[name="events"]:checked').map((input) => input.value);
  const data = new FormData(form);
  status.className = "form-status";

  if (!topics.length) return showFormStatus("Choose at least one legislative interest.", true);
  if (!events.length) return showFormStatus("Choose at least one type of update.", true);
  if (!form.reportValidity()) return;
  if (!config.subscriptionApiUrl) {
    return showFormStatus("The tracker is ready, but email subscriptions have not been activated by the site owner yet.", true);
  }
  status.textContent = "Submittingâ€¦";
  try {
    const response = await fetch(`${config.subscriptionApiUrl.replace(/\/$/, "")}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: data.get("email"), topics, events,
        frequency: data.get("frequency"),
        consent: data.get("consent") === "on",
        website: data.get("website")
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Subscription could not be completed.");
    form.reset();
    showFormStatus(result.message || "Check your email to confirm your subscription.", false);
  } catch (error) {
    showFormStatus(error.message, true);
  }
}

function showFormStatus(message, isError) {
  const status = $("#subscription-status");
  status.textContent = message;
  status.className = `form-status ${isError ? "error" : "success"}`;
}

function applyDeepLink() {
  const params = new URLSearchParams(location.search);
  const requested = (params.get("action") || params.get("bill") || "").toUpperCase();
  if (!requested) return;
  const bill = state.bills.find((item) => item.bill_number === requested || item.id === requested);
  if (bill && params.has("action")) selectBillForLetter(bill.id);
  if (bill && params.has("bill")) {
    $("#bill-search").value = bill.bill_number;
    renderBills();
  }
}

function bindEvents() {
  ["#bill-search", "#topic-filter", "#chamber-filter", "#status-filter"].forEach((selector) => {
    $(selector).addEventListener(selector === "#bill-search" ? "input" : "change", () => renderBills());
  });
  $("#session-filter").addEventListener("change", switchSession);
  $$('#subscription-form input[name="topics"]').forEach((input) => {
    input.addEventListener("change", () => {
      const priorSelection = $("#letter-bill").value;
      populateLetterBills(priorSelection);
      if (!$("#letter-bill").value) $("#letter-preview").value = "";
    });
  });
  $("#load-more").addEventListener("click", () => {
    state.visible += 30;
    const list = $("#bill-list");
    list.replaceChildren(...state.filtered.slice(0, state.visible).map(renderBillCard));
    $("#load-more").hidden = state.visible >= state.filtered.length;
  });
  $("#generate-letter").addEventListener("click", generateLetter);
  $("#letter-bill").addEventListener("change", generateLetter);
  $("#letter-position").addEventListener("change", generateLetter);
  $("#letter-audience").addEventListener("change", generateLetter);
  $("#copy-letter").addEventListener("click", copyLetter);
  $("#print-letter").addEventListener("click", () => window.print());
  $("#subscription-form").addEventListener("submit", submitSubscription);

  const config = window.MLW_CONFIG || {};
  $("#find-reps").href = config.representativeFinderUrl || "https://mgaleg.maryland.gov/";
  $("#mymga-link").href = config.myMgaUrl || "https://mgaleg.maryland.gov/";
}

document.addEventListener("DOMContentLoaded", initialize);
