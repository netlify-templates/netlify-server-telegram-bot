// The console: one page, plain functions, no framework and no build step.
// docs/console-api.md is the contract for every call below.

const $ = (selector, root = document) => root.querySelector(selector);

/** Makes an element: h("p", { class: "muted" }, "text", child). Props starting with "on" add listeners. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  el.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  return el;
}

/** A button that runs `fn` when clicked, disabled meanwhile, with any error shown in `errorEl`. */
const button = (label, errorEl, fn, cls = "small") =>
  h("button", { type: "button", class: cls, onclick: (event) => act(errorEl, fn, event.currentTarget) }, label);

// --- Talking to the server ---------------------------------------------------

/** Calls the JSON API. A 401 goes back to sign-in; other errors throw with a readable message. */
async function api(path, { method = "GET", body } = {}) {
  const fail = (status, message, data = {}) => Object.assign(new Error(message), { status, data });
  let res;
  try {
    const headers = body === undefined ? {} : { "content-type": "application/json" };
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw fail(0, "Couldn't reach the server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  if (res.status === 401 && path !== "/login") showSignIn();
  if (res.status === 429) throw fail(429, `Too many tries. Try again in ${formatWait(data.retryAfter)}.`, data);
  throw fail(res.status, data.error || `Something went wrong (HTTP ${res.status}).`, data);
}

const post = (path, body) => api(path, { method: "POST", body });

/** Runs an action, disabling `button` meanwhile and showing any error in `errorEl`. */
async function act(errorEl, fn, button) {
  errorEl.hidden = true;
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (err.status !== 401) showError(errorEl, err.message); // after a 401 the page is already at sign-in
  } finally {
    if (button) button.disabled = false;
  }
}

function showError(errorEl, message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

// --- Formatting --------------------------------------------------------------

const formatWait = (s) => (!(s >= 2) ? "a moment" : s < 90 ? `${Math.ceil(s)} seconds` : `${Math.ceil(s / 60)} minutes`);
const fullTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const isToday = (iso) => new Date(iso).toDateString() === new Date().toDateString();
const shortTime = (iso) => (isToday(iso) ? new Date(iso).toLocaleTimeString([], { timeStyle: "short" }) : fullTime(iso));

/** "2026-11-09" as "Mon, Nov 9", read as a calendar day rather than a UTC instant. */
function dayLabel(day) {
  const [y, m, d] = day.split("-").map(Number);
  return d ? new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : day;
}

function money(usd) {
  const n = Number(usd) || 0;
  return n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
}

/** Splits text into strings and links, so web addresses in replies can be clicked. */
const linkify = (text) =>
  String(text ?? "")
    .split(/(https?:\/\/[^\s<>"]*[^\s<>"'.,;:!?)\]])/)
    .map((part, i) => (i % 2 ? h("a", { href: part, target: "_blank", rel: "noopener noreferrer" }, part) : part));

const bar = (fraction) =>
  h("div", { class: "bar", "aria-hidden": "true" }, h("span", { style: `width: ${Math.min(1, fraction || 0) * 100}%` }));
const facts = (rows) => h("dl", { class: "facts" }, rows.flatMap(([term, value]) => [h("dt", {}, term), h("dd", {}, value)]));
const empty = (text) => h("li", { class: "empty" }, text);

// --- Sign-in -----------------------------------------------------------------

function showSignIn(session = {}) {
  stopPolling();
  $("#app").hidden = true;
  $("#signin").hidden = false;
  const off = session.consoleEnabled === false;
  $("#not-configured").hidden = !off;
  if (session.reason) $("#not-configured-reason").textContent = session.reason;
  $("#signin-form").hidden = off;
  if (!off) $("#password").focus();
}

$("#copy-prompt").addEventListener("click", () => {
  const [prompt, button] = [$("#agent-prompt"), $("#copy-prompt")];
  navigator.clipboard.writeText(prompt.textContent).then(
    () => (button.textContent = "Copied"),
    () => {
      getSelection().selectAllChildren(prompt); // so it can be copied by hand
      button.textContent = "Prompt selected, copy it from there";
    });
});

function showApp() {
  $("#signin").hidden = true;
  $("#app").hidden = false;
  showTab();
  loadChat();
  refreshTelegramHint();
  startPolling();
}

$("#signin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const [error, button] = [$("#signin-error"), $("#signin-button")];
  error.hidden = true;
  button.disabled = true;
  try {
    await post("/login", { password: $("#password").value });
    $("#password").value = "";
    button.disabled = false;
    showApp();
  } catch (err) {
    if (err.status === 503) return showSignIn({ consoleEnabled: false, reason: err.data.error });
    showError(error, err.status === 401 ? "That password isn't right." : err.message);
    // After a 429 the server won't take another try until retryAfter has passed.
    setTimeout(() => (button.disabled = false), err.status === 429 ? (err.data.retryAfter || 5) * 1000 : 0);
  }
});

$("#signout").addEventListener("click", async () => {
  await post("/logout").catch(() => {});
  showSignIn();
});

// --- Tabs: the address's #hash picks one, so links and the back button work ---

const tabs = { chat: scrollToEnd, memory: loadNotes, schedules: loadSchedules, status: loadStatus, settings: loadSettings };

function showTab() {
  const name = location.hash.slice(1) in tabs ? location.hash.slice(1) : "chat";
  for (const id in tabs) $(`#tab-${id}`).hidden = id !== name;
  for (const link of document.querySelectorAll("nav a")) {
    if (link.hash === `#${name}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
  if (!$("#app").hidden) tabs[name]();
}

window.addEventListener("hashchange", showTab);

// --- Chat --------------------------------------------------------------------

const log = $("#log");
const chatError = $("#chat-error");
const chat = { oldest: null, newest: null, timer: null, streams: new Set() };
const draft = { clientId: null, image: null };

const messageEl = (m) =>
  h("li", { class: `msg ${m.role}`, "data-id": m.id, "data-role": m.role, "data-run": m.runId },
    m.meta?.photo && h("span", { class: "tag" }, "Photo"),
    h("div", { class: "text" }, linkify(m.content)),
    h("time", { datetime: m.createdAt, title: fullTime(m.createdAt) }, shortTime(m.createdAt)));

/** A message this page sent or is streaming. The server's copy replaces it when a poll brings it in. */
function localMessage(role, content, runId, photo = false) {
  const el = messageEl({ role, content, runId, createdAt: new Date().toISOString(), meta: { photo } });
  el.dataset.pending = "";
  el.dataset.text = content;
  return el;
}

const hasRun = (role, runId) => log.querySelector(`[data-role="${role}"][data-run="${runId}"]`) !== null;

/** Finds the local copy of a server message: same role and run, or for the owner's own words, the same text. */
const findLocal = (m) =>
  [...log.querySelectorAll("[data-pending]")].find((el) => el.dataset.role === m.role &&
    ((m.runId != null && el.dataset.run === String(m.runId)) || (m.role === "user" && el.dataset.text === m.content)));

/** Adds server messages at the end, replacing local copies. `notify` is set for polled ones. */
function addMessages(messages, notify = false) {
  for (const m of messages) {
    chat.newest = m.id;
    chat.oldest ??= m.id;
    if (log.querySelector(`[data-id="${m.id}"]`)) continue;
    const local = findLocal(m);
    if (local) local.replaceWith(messageEl(m));
    else log.append(messageEl(m));
    if (!local && notify && m.role === "assistant") notifyIfHidden(m.content);
  }
}

async function loadChat() {
  log.replaceChildren();
  chat.oldest = chat.newest = null;
  $("#chat-empty").hidden = true; // shown once loaded, and only while the log is empty (app.css)
  await act(chatError, async () => {
    const { messages, hasMore } = await api("/messages?limit=50");
    addMessages(messages);
    $("#chat-empty").hidden = false;
    $("#older").hidden = !hasMore;
    scrollToEnd();
  });
  loadProposals();
}

$("#older").addEventListener("click", (event) => act(chatError, async () => {
  const { messages, hasMore } = await api(`/messages?before=${chat.oldest}&limit=50`);
  const height = document.documentElement.scrollHeight;
  log.prepend(...messages.filter((m) => !log.querySelector(`[data-id="${m.id}"]`)).map(messageEl));
  if (messages.length) chat.oldest = messages[0].id;
  $("#older").hidden = !hasMore;
  window.scrollBy(0, document.documentElement.scrollHeight - height); // keep the reader's place
}, event.currentTarget));

/** Picks up messages that arrived some other way: scheduled reports, Telegram, another tab. */
async function poll() {
  try {
    for (let more = true; more; ) {
      const { messages, hasMore } = await api(`/messages?${chat.newest == null ? "limit=50" : `after=${chat.newest}`}`);
      if (!messages.length) return;
      const atEnd = nearEnd();
      addMessages(messages, true);
      if (atEnd) scrollToEnd();
      more = hasMore;
    }
    loadProposals();
  } catch {
    // The next poll tries again.
  }
}

function startPolling() {
  stopPolling();
  chat.timer = setInterval(poll, 15_000);
}

function stopPolling() {
  clearInterval(chat.timer);
  chat.timer = null;
  for (const source of chat.streams) source.close();
  chat.streams.clear();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && chat.timer) poll();
});

const nearEnd = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 150;
function scrollToEnd() {
  window.scrollTo(0, document.documentElement.scrollHeight);
}

/** Follows one run's event stream into a reply bubble. EventSource reconnects by itself, with Last-Event-ID. */
function followRun(runId) {
  if (hasRun("assistant", runId)) return;
  const bubble = localMessage("assistant", "", runId);
  const textEl = $(".text", bubble);
  bubble.classList.add("streaming");
  bubble.setAttribute("aria-busy", "true");
  log.append(bubble);
  scrollToEnd();

  const source = new EventSource(`/api/runs/${runId}/events`);
  chat.streams.add(source);
  const seen = new Set();
  let text = "";

  // Progress events can come again after a reconnect, so those skip ids already seen.
  const on = (type, handle, replayable = false) =>
    source.addEventListener(type, (event) => {
      if (replayable && event.lastEventId) {
        if (seen.has(event.lastEventId)) return;
        seen.add(event.lastEventId);
      }
      const atEnd = nearEnd();
      handle(event.data ? JSON.parse(event.data) : {});
      if (atEnd) scrollToEnd();
    });
  const note = (label) => bubble.before(h("li", { class: "msg tool" }, label));
  const finish = () => {
    source.close();
    chat.streams.delete(source);
    bubble.classList.remove("streaming");
    bubble.removeAttribute("aria-busy");
    poll(); // the final reply is in /api/messages now
  };

  on("start", ({ attempt }) => {
    text = "";
    textEl.textContent = "";
    if (attempt > 1) note("Picking up again after an interruption");
  }, true);
  on("delta", (data) => {
    text += data.text;
    textEl.textContent = text;
  }, true);
  on("tool", (data) => note(data.label || data.name), true);
  on("done", (data) => {
    textEl.replaceChildren(...linkify(data.text));
    notifyIfHidden(data.text);
    finish();
  });
  on("failed", (data) => {
    bubble.className = "msg notice";
    bubble.dataset.role = "notice";
    textEl.textContent = data.text;
    finish();
  });
  on("missing", () => {
    bubble.remove();
    finish();
  });
  source.onerror = () => {
    if (source.readyState !== EventSource.CLOSED) return; // it's reconnecting on its own
    if (!text) textEl.textContent = "Lost the connection. The reply will show up here when it's ready.";
    finish();
  };
}

$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#text");
  const text = input.value.trim();
  if (!text && !draft.image) return;
  // The same clientId until the server accepts the message, so a resend after an error can't post it twice.
  draft.clientId ??= crypto.randomUUID();
  await act(chatError, async () => {
    const { runId } = await post("/chat", { text, clientId: draft.clientId, image: draft.image ?? undefined });
    if (!hasRun("user", runId)) log.append(localMessage("user", text, runId, Boolean(draft.image)));
    input.value = "";
    clearPhoto();
    followRun(runId);
  }, $("#send"));
  input.focus();
});

// Enter sends on a computer. Shift+Enter, or Enter on a phone, starts a new line.
$("#text").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || !matchMedia("(pointer: fine)").matches) return;
  event.preventDefault();
  $("#composer").requestSubmit();
});
$("#text").addEventListener("input", () => (draft.clientId = null));

$("#photo").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  chatError.hidden = true;
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type))
    return showError(chatError, "Photos can be JPEG, PNG, WebP or GIF.");
  if (file.size > 5 * 1024 * 1024) return showError(chatError, "That photo is over 5 MB. Try a smaller one.");
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  draft.image = { mediaType: file.type, data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  draft.clientId = null;
  $("#photo-name").textContent = `Photo: ${file.name}`;
  $("#photo-chip").hidden = false;
});

function clearPhoto() {
  draft.image = draft.clientId = null;
  $("#photo-chip").hidden = true;
}
$("#photo-remove").addEventListener("click", clearPhoto);

// Proposals: changes the assistant suggested after reading the web, waiting for a yes or no.
async function loadProposals() {
  try {
    const { proposals } = await api("/proposals");
    $("#proposals").replaceChildren(...proposals.map(proposalEl));
  } catch (err) {
    if (err.status !== 401) showError(chatError, err.message);
  }
}

function proposalEl(p) {
  const decide = (decision) => async () => {
    const { runId } = await post(`/proposals/${p.id}`, { decision });
    followRun(runId);
    await loadProposals();
  };
  return h("div", { class: "card proposal" },
    h("p", { class: "muted small" }, `Proposed change, waiting for you. Expires ${fullTime(p.expiresAt)}.`),
    h("p", { class: "text" }, p.summary),
    h("div", { class: "row" },
      button("Confirm", chatError, decide("confirm"), "small primary"),
      button("Discard", chatError, decide("discard"))));
}

// Browser notifications, for replies that arrive while the tab is in the background.
function updateNotifyButton() {
  $("#notify").hidden = !("Notification" in window) || Notification.permission !== "default";
}
$("#notify").addEventListener("click", () => Notification.requestPermission().then(updateNotifyButton));
updateNotifyButton();

function notifyIfHidden(text) {
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  const note = new Notification("New message from your assistant", { body: text.slice(0, 200), tag: "assistant" });
  note.onclick = () => window.focus();
}

async function refreshTelegramHint() {
  const status = await api("/status").catch(() => null);
  if (status) $("#telegram-hint").hidden = status.telegram.paired;
}

// --- Memory ------------------------------------------------------------------

const memoryError = $("#memory-error");

async function loadNotes() {
  await act(memoryError, async () => {
    const { notes, used, limit } = await api("/notes");
    $("#memory-usage").textContent = `${used.toLocaleString()} of ${limit.toLocaleString()} characters used`;
    $("#memory-bar").style.width = `${Math.min(100, (used / limit) * 100)}%`;
    $("#notes").replaceChildren(...notes.map(noteEl));
    if (!notes.length) $("#notes").append(empty("No notes yet. Add one above, or tell the assistant something to remember."));
  });
}

function noteEl(note) {
  const li = h("li", { class: "card" });

  function view() {
    li.replaceChildren(
      h("p", { class: "text" }, note.content),
      h("div", { class: "row" },
        h("span", { class: "muted small grow" }, `Note ${note.id}, updated ${fullTime(note.updatedAt)}`),
        h("button", { type: "button", class: "small", onclick: edit }, "Edit"),
        button("Delete", memoryError, remove, "small danger")));
  }

  function edit() {
    const box = h("textarea", { rows: 3, maxlength: 400, "aria-label": `Note ${note.id}`, value: note.content });
    const save = async () => {
      await api(`/notes/${note.id}`, { method: "PUT", body: { content: box.value.trim() } });
      await loadNotes();
    };
    li.replaceChildren(box, h("div", { class: "row" },
      button("Save", memoryError, save, "small primary"),
      h("button", { type: "button", class: "small", onclick: view }, "Cancel")));
    box.focus();
  }

  async function remove() {
    if (!confirm("Delete this note? This can't be undone.")) return;
    await api(`/notes/${note.id}`, { method: "DELETE" });
    await loadNotes();
  }

  view();
  return li;
}

$("#note-form").addEventListener("submit", (event) => {
  event.preventDefault();
  act(memoryError, async () => {
    await post("/notes", { content: $("#note-new").value.trim() });
    $("#note-new").value = "";
    await loadNotes();
  }, event.submitter);
});

// --- Schedules ---------------------------------------------------------------

const schedulesError = $("#schedules-error");

async function loadSchedules() {
  await act(schedulesError, async () => {
    const { schedules, limit, templates } = await api("/schedules");
    $("#schedules-count").textContent = `${schedules.length} of ${limit} schedules`;
    $("#schedule-list").replaceChildren(...schedules.map(scheduleEl));
    const hint = 'None yet. Start from a template below, or ask in chat, like "remind me every Monday at 9".';
    if (!schedules.length) $("#schedule-list").append(empty(hint));
    $("#templates").replaceChildren(...templates.map(templateEl));
  });
}

function scheduleEl(s) {
  const status = h("span", { class: "muted small", role: "status" });
  const when = s.paused ? "Paused" : s.nextRunAt ? `Next run ${fullTime(s.nextRunAt)}` : "No run planned";
  const failures = s.failures ? `. Failed ${s.failures} time${s.failures > 1 ? "s" : ""} in a row.` : "";
  const mode = s.mode === "watch" ? "Tells you only when something changes" : "Sends a report every time";

  const togglePause = async () => {
    await api(`/schedules/${s.id}`, { method: "PATCH", body: { paused: !s.paused } });
    await loadSchedules();
  };
  const runNow = async () => {
    await post(`/schedules/${s.id}/run`);
    status.textContent = "Started. The report will show up in Chat.";
  };
  const remove = async () => {
    if (!confirm("Delete this schedule?")) return;
    await api(`/schedules/${s.id}`, { method: "DELETE" });
    await loadSchedules();
  };

  return h("li", { class: "card" },
    h("p", { class: "text" }, s.instruction),
    h("p", { class: "muted small" }, `${s.ruleText}. ${mode}.`),
    h("p", { class: "small" }, when + failures),
    s.lastReport && h("details", {}, h("summary", {}, "Last report"), h("p", { class: "text small" }, s.lastReport)),
    h("div", { class: "row" },
      button(s.paused ? "Resume" : "Pause", schedulesError, togglePause),
      button("Run now", schedulesError, runNow),
      button("Delete", schedulesError, remove, "small danger"),
      status));
}

/** A starter schedule as a small form, built from the template's fields. */
function templateEl(t) {
  const field = (f) => [
    h("label", { for: `${t.id}-${f.name}` }, f.label, !f.required && h("span", { class: "muted" }, " (optional)")),
    h("input", {
      id: `${t.id}-${f.name}`, name: f.name, type: /url/i.test(f.name) ? "url" : "text",
      placeholder: f.placeholder, required: f.required,
    }),
  ];
  const form = h("form", { class: "card" },
    h("h4", {}, t.title),
    h("p", { class: "muted small" }, t.description),
    t.fields.flatMap(field),
    h("div", { class: "row" }, h("button", { type: "submit", class: "small primary" }, "Add schedule")));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    act(schedulesError, async () => {
      await post("/schedules", { template: t.id, fields: Object.fromEntries(new FormData(form)) });
      form.reset();
      await loadSchedules();
    }, event.submitter);
  });
  return form;
}

// --- Status ------------------------------------------------------------------

const statusError = $("#status-error");
const WEBHOOK = {
  connected: "Connected to this site",
  missing: "Not connected, so Telegram messages aren't arriving",
  elsewhere: "Connected to another address, so messages go there",
  unknown: "Couldn't check",
};

async function loadStatus() {
  await act(statusError, async () => {
    const s = await api("/status");
    $("#telegram-hint").hidden = s.telegram.paired;
    $("#status-cards").replaceChildren(
      telegramCard(s.telegram),
      spendCard(s.spend),
      h("section", { class: "card" }, h("h3", {}, "Runs"), facts([
        ["Running", s.runs.running],
        ["Queued", s.runs.queued],
        ["Failed today", s.runs.failedToday],
        ["Last wake call", s.wake.lastCallAt ? shortTime(s.wake.lastCallAt) : "None yet"],
      ])),
      deliveriesCard(s.deliveries.failed),
      h("p", { class: "muted small" }, `Build ${s.build}, instance ${s.instance}`));
  }, $("#status-refresh"));
}

$("#status-refresh").addEventListener("click", () => {
  $("#status-note").textContent = "";
  loadStatus();
});

function telegramCard(t) {
  const card = h("section", { class: "card" }, h("h3", {}, "Telegram"));
  if (!t.configured) {
    card.append(
      h("p", {}, "Telegram isn't set up on this site yet, so reminders and reports show up here."),
      h("p", {}, "To connect it, create a bot with @BotFather in Telegram, set its token as ", h("code", {}, "TELEGRAM_BOT_TOKEN"),
        " in the site's environment variables, and redeploy. The README has the steps."));
    return card;
  }
  const pairing = h("div", { class: "stack" });

  const pair = async () => {
    const { link, expiresAt } = await post("/telegram/pair");
    const a = h("a", { href: link, target: "_blank", rel: "noopener", class: "pair-link" }, link);
    const copy = h("button", { type: "button", class: "small" }, "Copy link");
    copy.onclick = () => navigator.clipboard.writeText(link).then(
      () => (copy.textContent = "Copied"),
      () => {
        getSelection().selectAllChildren(a); // so it can be copied by hand
        copy.textContent = "Link selected, copy it from there";
      });
    pairing.replaceChildren(
      h("p", {}, `Open this link where you use Telegram and press Start. It works once, until ${shortTime(expiresAt)}.`),
      h("div", { class: "row" }, a, copy));
  };
  const reconnect = async () => {
    const { url } = await post("/telegram/webhook");
    await loadStatus();
    $("#status-note").textContent = `The bot now sends its messages to ${url}.`;
  };

  card.append(
    facts([
      ["Bot", t.botUsername ? `@${t.botUsername}` : "Unknown"],
      ["Paired", t.paired ? "Yes" : "Not yet"],
      ["Connection", WEBHOOK[t.webhook] ?? t.webhook],
    ]),
    t.lastError ? h("p", { class: "error small" }, `Last error: ${t.lastError}`) : "",
    h("div", { class: "row" },
      button(t.paired ? "Pair again" : "Connect Telegram", statusError, pair, t.paired ? "small" : "small primary"),
      button("Reconnect", statusError, reconnect)),
    pairing);
  return card;
}

const spendCard = (spend) =>
  h("section", { class: "card" },
    h("h3", {}, "Spend"),
    h("p", {},
      h("strong", {}, money(spend.today)),
      ` of the ${money(spend.cap)} daily cap today`,
      spend.reserved > 0 && h("span", { class: "muted" }, `, plus ${money(spend.reserved)} held for runs in progress`)),
    bar(spend.today / spend.cap),
    spend.days.length > 0 && h("ul", { class: "days", "aria-label": "Spend per day" }, spend.days.map((d) =>
      h("li", {}, h("span", {}, dayLabel(d.day)), bar(d.spent / spend.cap), h("span", {}, money(d.spent))))));

function deliveriesCard(failed) {
  const retry = (id) => async () => {
    await post(`/deliveries/${id}/retry`);
    await loadStatus();
  };
  const item = (d) =>
    h("li", { class: "stack" },
      h("p", { class: "text clamp" }, d.text),
      h("p", { class: "muted small" }, `${fullTime(d.createdAt)}. ${d.lastError}`),
      h("div", {}, button("Retry", statusError, retry(d.id))));
  return h("section", { class: "card" },
    h("h3", {}, "Failed deliveries"),
    failed.length ? h("ul", { class: "list" }, failed.map(item)) : h("p", { class: "muted" }, "None. Everything was delivered."));
}

// --- Settings ----------------------------------------------------------------

const settingsError = $("#settings-error");
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
$("#tz-list").append(...(Intl.supportedValuesOf?.("timeZone") ?? []).map((zone) => h("option", { value: zone })));

async function loadSettings() {
  $("#settings-saved").textContent = "";
  await act(settingsError, async () => fillSettings(await api("/settings")));
}

function fillSettings(s) {
  const persona = s.persona ?? {};
  $("#tz").value = s.timezone || browserZone;
  const useIt = h("button", { type: "button", class: "link small", onclick: () => ($("#tz").value = browserZone) }, "Use it");
  if (!s.timezone) $("#tz-hint").replaceChildren(`Suggested from this browser (${browserZone}). Save to use it.`);
  else if (s.timezone !== browserZone) $("#tz-hint").replaceChildren(`This browser is set to ${browserZone}. `, useIt);
  else $("#tz-hint").replaceChildren();

  $("#model").replaceChildren(...s.models.map((m) => h("option", { value: m.id }, m.label)));
  $("#model").value = s.model;
  $("#cap").value = s.dailyCapUsd;
  $("#presets").replaceChildren(...s.presets.map((p) =>
    h("label", { class: "preset" },
      h("input", { type: "radio", name: "preset", value: p.id, checked: p.id === persona.preset }),
      h("span", {}, h("strong", {}, p.name), h("span", { class: "muted small" }, p.description)))));
  $("#persona-name").value = persona.name ?? "";
  $("#soul").value = persona.soul ?? "";
}

$("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const timezone = $("#tz").value.trim();
  $("#settings-saved").textContent = "";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    return showError(settingsError, "That isn't a time zone this browser knows. Try one like Europe/Berlin.");
  }
  const body = {
    timezone,
    model: $("#model").value,
    dailyCapUsd: Number($("#cap").value),
    persona: { preset: $("#presets input:checked")?.value, name: $("#persona-name").value.trim(), soul: $("#soul").value.trim() },
  };
  act(settingsError, async () => {
    fillSettings(await api("/settings", { method: "PUT", body }));
    $("#settings-saved").textContent = "Saved.";
  }, event.submitter);
});

// --- Start -------------------------------------------------------------------

async function start() {
  try {
    const session = await api("/session");
    if (session.signedIn) showApp();
    else showSignIn(session);
  } catch (err) {
    if (err.status === 401) return; // api() already showed sign-in
    showSignIn(err.status === 503 ? { consoleEnabled: false, reason: err.data.error } : {});
    if (err.status !== 503) showError($("#signin-error"), err.message);
  }
}

start();
