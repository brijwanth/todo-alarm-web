import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";
import { occurrencesBetween, nextOccurrence, describe, todayIso, dayStartMs, isSubDaily } from "./recurrence.js";

// ------------------------------------------------------------------ setup

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => crypto.randomUUID();
const DAY = 86400000;

let user = null;
let tasks = new Map();          // id -> task
let view = "today";             // today | upcoming | tasks | trash
let selectedId = null;
let query = "";
let unsub = null;

const fmtTime = ms => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const fmtDay = ms => new Date(ms).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

// ------------------------------------------------------------------ model helpers (mirror the Kotlin Task / AlarmSpec)

function newTask(title, parentId = null) {
  const now = Date.now();
  const siblings = [...tasks.values()].filter(t => t.parentId === parentId);
  return {
    id: uid(), parentId, title, notes: "", priority: "NONE", list: "",
    order: Math.max(0, ...siblings.map(t => t.order || 0)) + 1,
    done: false, doneAt: null, deleted: false, deletedAt: null,
    createdAt: now, updatedAt: now, alarms: [], completions: [],
  };
}

function newAlarm() {
  const now = new Date(Date.now() + 330 * 60000); // IST wall clock in UTC fields
  const hour = (now.getUTCHours() + 1) % 24;
  const today = todayIso();
  const date = hour === 0 ? todayIso(Date.now() + DAY) : today;
  return {
    id: uid(), enabled: true, type: "ONCE", hour, minute: 0, date, weekdays: [],
    interval: 1, intervalUnit: "DAYS", dayOfMonth: 1, startDate: today, endDate: null,
    maxCount: null, preAlertMin: 0, sound: null, vibrate: true, zone: "Asia/Kolkata",
  };
}

const completionKey = (alarmId, at) => `${alarmId}@${at}`;
const isOccDone = (t, alarmId, at) => t.done || (t.completions || []).includes(completionKey(alarmId, at));

function save(task) {
  const old = tasks.get(task.id);
  task.updatedAt = Math.max(Date.now(), (old?.updatedAt || 0) + 1);
  tasks.set(task.id, task);
  render();
  return setDoc(doc(db, "users", user.uid, "tasks", task.id), {
    json: JSON.stringify(task), updatedAt: task.updatedAt, deleted: !!task.deleted, parentId: task.parentId ?? null,
  }).catch(e => toast("Save failed: " + e.message));
}

function removeForever(id) {
  tasks.delete(id);
  render();
  return deleteDoc(doc(db, "users", user.uid, "tasks", id));
}

function live() { return [...tasks.values()].filter(t => !t.deleted); }
function childrenOf(id) { return live().filter(t => t.parentId === id).sort((a, b) => (a.order || 0) - (b.order || 0)); }

function agenda(fromMs, toMs) {
  const items = [];
  const now = Date.now();
  for (const t of live()) {
    if (t.parentId && tasks.get(t.parentId)?.deleted) continue;
    for (const a of t.alarms || []) {
      if (!a.enabled) continue;
      let times = occurrencesBetween(a, isSubDaily(a) ? Math.max(fromMs, now - 60000) : fromMs, toMs);
      if (isSubDaily(a)) times = times.slice(0, 1);
      for (const at of times) items.push({ task: t, alarm: a, at, done: isOccDone(t, a.id, at) });
    }
  }
  return items.sort((x, y) => x.at - y.at);
}

function nextAlarmAt(t) {
  const now = Date.now();
  const n = (t.alarms || []).filter(a => a.enabled).map(a => nextOccurrence(a, now)).filter(x => x != null);
  return n.length ? Math.min(...n) : null;
}

function toggleOccurrence(taskId, alarmId, at) {
  const t = structuredClone(tasks.get(taskId));
  const a = t.alarms.find(x => x.id === alarmId);
  if (a && a.type !== "ONCE") {
    const k = completionKey(alarmId, at);
    t.completions = t.completions.includes(k) ? t.completions.filter(x => x !== k) : [...t.completions, k].slice(-200);
  } else {
    t.done = !t.done; t.doneAt = t.done ? Date.now() : null;
  }
  save(t);
}

function toggleDone(id) {
  const t = structuredClone(tasks.get(id));
  t.done = !t.done; t.doneAt = t.done ? Date.now() : null;
  save(t);
}

function trash(id) {
  const now = Date.now();
  for (const t of [tasks.get(id), ...childrenOf(id)]) save({ ...structuredClone(t), deleted: true, deletedAt: now });
  if (selectedId === id) selectedId = null;
}

function restore(id) {
  const t = tasks.get(id);
  const group = [t, ...[...tasks.values()].filter(x => x.parentId === id && x.deleted)];
  if (t.parentId && tasks.get(t.parentId)?.deleted) group.push(tasks.get(t.parentId));
  for (const x of group) save({ ...structuredClone(x), deleted: false, deletedAt: null });
}

// ------------------------------------------------------------------ rendering

const priColor = { HIGH: "#e5484d", MED: "#f5a524", LOW: "#3e8ede", NONE: "transparent" };

function render() {
  if (!user) return;
  document.querySelectorAll("nav button[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("#main").innerHTML = view === "today" ? renderToday() : view === "upcoming" ? renderUpcoming()
    : view === "trash" ? renderTrash() : renderTasks();
  $("#detail").innerHTML = selectedId && tasks.get(selectedId) && !tasks.get(selectedId).deleted ? renderDetail(tasks.get(selectedId)) : `<div class="empty">Select a task to edit it.</div>`;
  $("#detail").classList.toggle("open", !!selectedId);
}

function agendaRow(it, { showDay = false, late = false } = {}) {
  const parent = it.task.parentId ? tasks.get(it.task.parentId) : null;
  return `<div class="row ${it.done ? "done" : ""}" data-open="${it.task.id}">
    <input type="checkbox" ${it.done ? "checked" : ""} data-occ="${it.task.id}|${it.alarm.id}|${it.at}">
    <div class="time ${late ? "late" : ""}">${fmtTime(it.at)}${showDay ? `<small>${fmtDay(it.at)}</small>` : ""}</div>
    <div class="grow"><div class="title">${esc(it.task.title)}</div>
      <small>${[parent ? "in " + esc(parent.title) : "", it.alarm.type !== "ONCE" ? "repeats" : ""].filter(Boolean).join(" · ")}</small></div>
    <span class="dot" style="background:${priColor[it.task.priority] || "transparent"}"></span>
  </div>`;
}

function renderToday() {
  const today = todayIso();
  const start = dayStartMs(today), now = Date.now();
  const overdue = agenda(start - 30 * DAY, start).filter(i => !i.done && i.alarm.type === "ONCE");
  const items = agenda(start, start + DAY);
  return `<h2>Today · ${fmtDay(now)}</h2>
    ${overdue.length ? `<h3 class="red">Overdue</h3>${overdue.map(i => agendaRow(i, { showDay: true, late: true })).join("")}` : ""}
    <h3>Timeline</h3>
    ${items.length ? items.map(i => agendaRow(i, { late: !i.done && i.at < now })).join("") : `<div class="empty">No alarms today.</div>`}
    ${quickAdd()}`;
}

function renderUpcoming() {
  const start = dayStartMs(todayIso()) + DAY;
  const items = agenda(start, start + 7 * DAY);
  const groups = {};
  for (const i of items) (groups[fmtDay(i.at)] ||= []).push(i);
  return `<h2>Next 7 days</h2>
    ${items.length ? Object.entries(groups).map(([d, l]) => `<h3>${d}</h3>${l.map(i => agendaRow(i)).join("")}`).join("") : `<div class="empty">Nothing scheduled.</div>`}
    ${quickAdd()}`;
}

function taskRow(t) {
  const subs = childrenOf(t.id);
  const next = nextAlarmAt(t);
  const bits = [subs.length ? `${subs.filter(s => s.done).length}/${subs.length} subtasks` : "", t.list ? esc(t.list) : "",
    next ? `⏰ ${fmtDay(next)} ${fmtTime(next)}` : ""].filter(Boolean).join(" · ");
  return `<div class="row ${t.done ? "done" : ""} ${t.id === selectedId ? "sel" : ""}" data-open="${t.id}">
    <input type="checkbox" ${t.done ? "checked" : ""} data-done="${t.id}">
    <div class="grow"><div class="title">${esc(t.title || "(untitled)")}</div>${bits ? `<small>${bits}</small>` : ""}</div>
    <span class="dot" style="background:${priColor[t.priority] || "transparent"}"></span></div>`;
}

function renderTasks() {
  const q = query.trim().toLowerCase();
  const all = live();
  const match = t => !q || (t.title + " " + t.notes).toLowerCase().includes(q);
  const top = all.filter(t => !t.parentId && (match(t) || all.some(s => s.parentId === t.id && match(s))))
    .sort((a, b) => ({ HIGH: 3, MED: 2, LOW: 1, NONE: 0 }[b.priority] - { HIGH: 3, MED: 2, LOW: 1, NONE: 0 }[a.priority]) || (a.order - b.order));
  const open = top.filter(t => !t.done), done = top.filter(t => t.done);
  return `<h2>Tasks</h2>
    <input id="search" placeholder="Search tasks and subtasks" value="${esc(query)}">
    ${quickAdd()}
    ${open.map(taskRow).join("") || `<div class="empty">No open tasks.</div>`}
    ${done.length ? `<details><summary>Completed (${done.length})</summary>${done.map(taskRow).join("")}</details>` : ""}`;
}

function renderTrash() {
  const del = [...tasks.values()].filter(t => t.deleted && !(t.parentId && tasks.get(t.parentId)?.deleted));
  return `<h2>Trash</h2><p class="muted">The phone empties items older than 30 days.</p>
    ${del.map(t => `<div class="row"><div class="grow">${esc(t.title || "(untitled)")}</div>
      <button data-restore="${t.id}">Restore</button><button class="danger" data-forever="${t.id}">Delete</button></div>`).join("") || `<div class="empty">Trash is empty.</div>`}`;
}

function quickAdd() {
  return `<form class="quickadd" data-add><input name="title" placeholder="+ New task… (Enter)" autocomplete="off"></form>`;
}

function renderDetail(t) {
  const parent = t.parentId ? tasks.get(t.parentId) : null;
  const subs = childrenOf(t.id);
  const now = Date.now();
  return `<div class="detail-head">
      <button class="ghost" data-close>✕</button>
      ${parent ? `<button class="ghost" data-open="${parent.id}">↑ ${esc(parent.title)}</button>` : ""}
      <span class="grow"></span><button class="danger" data-trash="${t.id}">Move to Trash</button></div>
    <label class="check"><input type="checkbox" ${t.done ? "checked" : ""} data-done="${t.id}"> Done</label>
    <input class="big" data-field="title" value="${esc(t.title)}" placeholder="Title">
    <textarea data-field="notes" placeholder="Notes" rows="3">${esc(t.notes)}</textarea>
    <div class="chips">${["NONE", "LOW", "MED", "HIGH"].map(p => `<button class="chip ${t.priority === p ? "on" : ""}" data-priority="${p}">
      <span class="dot" style="background:${priColor[p]}"></span>${p[0] + p.slice(1).toLowerCase()}</button>`).join("")}</div>
    ${parent ? "" : `<input data-field="list" value="${esc(t.list)}" placeholder="List / tag (e.g. Work)">`}
    <h3>Alarms</h3>
    ${(t.alarms || []).map(a => {
      const n = nextOccurrence(a, now);
      return `<div class="alarm"><div class="grow" data-edit-alarm="${a.id}"><b>⏰ ${esc(describe(a))}</b>
        <small>${n ? "Next: " + fmtDay(n) + " " + fmtTime(n) : "No more occurrences"}</small></div>
        <label class="switch"><input type="checkbox" ${a.enabled ? "checked" : ""} data-alarm-toggle="${a.id}"> on</label></div>`;
    }).join("") || `<div class="empty">No alarms.</div>`}
    <button data-add-alarm>+ Add alarm</button>
    ${parent ? "" : `<h3>Subtasks (${subs.filter(s => s.done).length}/${subs.length})</h3>
      ${subs.map(s => `<div class="row ${s.done ? "done" : ""}" data-open="${s.id}"><input type="checkbox" ${s.done ? "checked" : ""} data-done="${s.id}">
        <div class="grow">${esc(s.title)}</div>${(s.alarms || []).some(a => a.enabled) ? "⏰" : ""}</div>`).join("")}
      <form class="quickadd" data-add-sub="${t.id}"><input name="title" placeholder="+ Subtask… (Enter)" autocomplete="off"></form>`}`;
}

// ------------------------------------------------------------------ alarm editor (dialog)

function openAlarmEditor(taskId, alarmId) {
  const t = tasks.get(taskId);
  const isNew = !alarmId;
  let a = isNew ? newAlarm() : structuredClone(t.alarms.find(x => x.id === alarmId));
  const dlg = $("#alarmDlg");
  const pad = n => String(n).padStart(2, "0");
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function draw() {
    const n = nextOccurrence(finalised(a), Date.now());
    dlg.innerHTML = `<form method="dialog" class="dlg">
      <h3>${isNew ? "New alarm" : "Edit alarm"}</h3>
      <label>Time <input type="time" name="time" value="${pad(a.hour)}:${pad(a.minute)}" required></label>
      <div class="chips">${[["ONCE", "Once"], ["DAILY", "Daily"], ["WEEKDAYS", "Weekdays"], ["INTERVAL", "Every N"], ["MONTHLY", "Monthly"]]
        .map(([k, l]) => `<button type="button" class="chip ${a.type === k ? "on" : ""}" data-type="${k}">${l}</button>`).join("")}</div>
      ${a.type === "ONCE" ? `<label>Date <input type="date" name="date" value="${a.date || ""}"></label>` : ""}
      ${a.type === "WEEKDAYS" ? `<div class="chips">${DAYS.map((d, i) => `<button type="button" class="chip ${a.weekdays.includes(i + 1) ? "on" : ""}" data-wd="${i + 1}">${d}</button>`).join("")}</div>` : ""}
      ${a.type === "INTERVAL" ? `<label>Every <input type="number" min="1" max="999" name="interval" value="${a.interval}"></label>
        <div class="chips">${[["MINUTES", "minutes"], ["HOURS", "hours"], ["DAYS", "days"], ["WEEKS", "weeks"]]
          .map(([k, l]) => `<button type="button" class="chip ${a.intervalUnit === k ? "on" : ""}" data-unit="${k}">${l}</button>`).join("")}</div>` : ""}
      ${a.type === "MONTHLY" ? `<label>Day of month <input type="number" min="1" max="31" name="dom" value="${a.dayOfMonth === -1 ? "" : a.dayOfMonth}" ${a.dayOfMonth === -1 ? "disabled" : ""}></label>
        <label class="check"><input type="checkbox" name="lastday" ${a.dayOfMonth === -1 ? "checked" : ""}> Last day of month</label>` : ""}
      ${a.type !== "ONCE" ? `<label>Starts <input type="date" name="startDate" value="${a.startDate || ""}"></label>
        <label>Ends (optional) <input type="date" name="endDate" value="${a.endDate || ""}"></label>
        <label>Stop after (times, blank = never) <input type="number" min="1" name="maxCount" value="${a.maxCount ?? ""}"></label>` : ""}
      <label>Early warning <select name="pre">${[0, 5, 10, 15, 30, 60].map(m => `<option value="${m}" ${a.preAlertMin === m ? "selected" : ""}>${m ? m + " min before" : "None"}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" name="vibrate" ${a.vibrate ? "checked" : ""}> Vibrate on phone</label>
      <p class="${n ? "ok" : "red"}">${esc(describe(finalised(a)))}<br>${n ? "Next: " + fmtDay(n) + " " + fmtTime(n) : "⚠ No future occurrence"}</p>
      <p class="muted">The alarm sound is chosen on the phone.</p>
      <div class="dlg-actions">${isNew ? "" : `<button type="button" class="danger" data-del>Delete</button>`}<span class="grow"></span>
        <button type="button" data-cancel>Cancel</button><button type="button" class="primary" data-save>Save</button></div></form>`;
  }

  function readForm() {
    const f = $("form", dlg);
    const [h, m] = (f.time?.value || "09:00").split(":").map(Number);
    a.hour = h; a.minute = m;
    if (f.date) a.date = f.date.value || null;
    if (f.interval) a.interval = Math.max(1, +f.interval.value || 1);
    if (f.lastday) a.dayOfMonth = f.lastday.checked ? -1 : Math.min(31, Math.max(1, +f.dom.value || 1));
    if (f.startDate) a.startDate = f.startDate.value || null;
    if (f.endDate) a.endDate = f.endDate.value || null;
    if (f.maxCount) a.maxCount = f.maxCount.value ? Math.max(1, +f.maxCount.value) : null;
    a.preAlertMin = +f.pre.value;
    a.vibrate = f.vibrate.checked;
  }

  function finalised(x) {
    const today = todayIso();
    const y = { ...x };
    if (y.type === "ONCE") y.date ||= today;
    else y.startDate ||= today;
    if (y.type === "WEEKDAYS" && !y.weekdays.length) y.weekdays = [1, 2, 3, 4, 5];
    return y;
  }

  dlg.onclick = e => {
    const b = e.target.closest("button");
    if (!b) return;
    readForm();
    if (b.dataset.type) a.type = b.dataset.type;
    else if (b.dataset.wd) { const d = +b.dataset.wd; a.weekdays = a.weekdays.includes(d) ? a.weekdays.filter(x => x !== d) : [...a.weekdays, d].sort(); }
    else if (b.dataset.unit) a.intervalUnit = b.dataset.unit;
    else if (b.hasAttribute("data-cancel")) return dlg.close();
    else if (b.hasAttribute("data-del")) {
      const c = structuredClone(tasks.get(taskId)); c.alarms = c.alarms.filter(x => x.id !== a.id); save(c); return dlg.close();
    } else if (b.hasAttribute("data-save")) {
      const c = structuredClone(tasks.get(taskId)); const fa = finalised(a);
      c.alarms = c.alarms.some(x => x.id === fa.id) ? c.alarms.map(x => x.id === fa.id ? fa : x) : [...c.alarms, fa];
      save(c); return dlg.close();
    }
    draw();
  };
  dlg.onchange = () => { readForm(); draw(); };
  draw();
  dlg.showModal();
}

// ------------------------------------------------------------------ events

document.addEventListener("click", e => {
  const el = e.target;
  if (el.matches("input[type=checkbox][data-occ]")) { const [t, a, at] = el.dataset.occ.split("|"); toggleOccurrence(t, a, +at); return; }
  if (el.matches("input[type=checkbox][data-done]")) { toggleDone(el.dataset.done); return; }
  if (el.matches("input[type=checkbox][data-alarm-toggle]")) {
    const c = structuredClone(tasks.get(selectedId));
    c.alarms = c.alarms.map(x => x.id === el.dataset.alarmToggle ? { ...x, enabled: el.checked } : x); save(c); return;
  }
  const b = el.closest("[data-view],[data-open],[data-close],[data-trash],[data-restore],[data-forever],[data-priority],[data-add-alarm],[data-edit-alarm],#signout,#signin,#notify");
  if (!b) return;
  if (b.dataset.view) { view = b.dataset.view; render(); }
  else if (b.dataset.open) { selectedId = b.dataset.open; render(); }
  else if (b.hasAttribute("data-close")) { selectedId = null; render(); }
  else if (b.dataset.trash) { if (confirm("Move to Trash? Subtasks go too.")) trash(b.dataset.trash); }
  else if (b.dataset.restore) restore(b.dataset.restore);
  else if (b.dataset.forever) { if (confirm("Delete forever?")) { childrenOf(b.dataset.forever).forEach(c => removeForever(c.id)); removeForever(b.dataset.forever); } }
  else if (b.dataset.priority) { const c = structuredClone(tasks.get(selectedId)); c.priority = b.dataset.priority; save(c); }
  else if (b.hasAttribute("data-add-alarm")) openAlarmEditor(selectedId, null);
  else if (b.dataset.editAlarm) openAlarmEditor(selectedId, b.dataset.editAlarm);
  else if (b.id === "signin") signInWithPopup(auth, new GoogleAuthProvider()).catch(err => toast("Sign-in failed: " + err.message));
  else if (b.id === "signout") signOut(auth);
  else if (b.id === "notify") onNotifyClick();
});

document.addEventListener("submit", e => {
  const f = e.target;
  if (!f.matches("[data-add],[data-add-sub]")) return;
  e.preventDefault();
  const title = f.title.value.trim();
  if (!title) return;
  const t = newTask(title, f.dataset.addSub || null);
  save(t);
  if (!f.dataset.addSub) selectedId = t.id;
  f.title.value = "";
  render();
  setTimeout(() => { const i = document.querySelector(f.dataset.addSub ? `[data-add-sub="${f.dataset.addSub}"] input` : "[data-add] input"); i?.focus(); }, 0);
});

// Text fields: save 500 ms after typing stops (no re-render while typing).
let typingTimer = null;
document.addEventListener("input", e => {
  const el = e.target;
  if (el.id === "search") {
    query = el.value;
    const pos = el.selectionStart;
    render();
    const s = $("#search"); s.focus(); s.setSelectionRange(pos, pos);
    return;
  }
  if (!el.dataset.field || !selectedId) return;
  const id = selectedId, field = el.dataset.field, value = el.value;
  tasks.get(id)[field] = value; // keep local copy current
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    const c = structuredClone(tasks.get(id)); c[field] = value;
    const active = document.activeElement, pos = active?.selectionStart;
    save(c);
    const again = document.querySelector(`[data-field="${field}"]`);
    if (again && active?.dataset?.field === field) { again.focus(); again.setSelectionRange?.(pos, pos); }
  }, 500);
});

// ------------------------------------------------------------------ laptop notifications (while this page is open)

function updateNotifyBtn() {
  const b = $("#notify");
  if (!("Notification" in window)) { b.textContent = "Reminders not supported in this browser"; b.disabled = true; return; }
  b.disabled = false;
  b.textContent = Notification.permission === "granted" ? "🔔 Reminders on (send test)"
    : Notification.permission === "denied" ? "🔕 Reminders blocked — how to fix"
    : "🔕 Turn on laptop reminders";
}

function testNotification() {
  try {
    const n = new Notification("Todo Alarm", { body: "Laptop reminders are working ✅", tag: "test" });
    setTimeout(() => n.close(), 8000);
    toast("Test sent. No pop-up? Check Windows Settings → System → Notifications → Google Chrome is On, and Do Not Disturb is off.");
  } catch (e) { toast("Couldn't show a notification: " + e.message); }
}

async function onNotifyClick() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") return testNotification();
  if (Notification.permission === "denied") {
    return toast("Chrome is blocking notifications for this page. Click the icon at the left of the address bar → Site settings → Notifications → Allow, then reload the page.");
  }
  const result = await Notification.requestPermission();
  updateNotifyBtn();
  if (result === "granted") testNotification();
  else if (result === "default") toast("No prompt? Look for a bell icon at the right end of the address bar and click Allow.");
  else toast("Notifications were blocked. To undo: address bar icon → Site settings → Notifications → Allow.");
}

function checkDue() {
  if (!user || Notification.permission !== "granted") return;
  const now = Date.now();
  let shown = {};
  try { shown = JSON.parse(localStorage.getItem("shown") || "{}"); } catch { /* ignore */ }
  for (const it of agenda(now - 120000, now + 1000)) {
    const key = it.alarm.id + "@" + it.at;
    if (it.done || shown[key]) continue;
    shown[key] = now;
    new Notification(it.task.title, { body: "Alarm · " + fmtTime(it.at), tag: key, requireInteraction: true });
  }
  for (const k of Object.keys(shown)) if (now - shown[k] > 2 * DAY) delete shown[k];
  try { localStorage.setItem("shown", JSON.stringify(shown)); } catch { /* ignore */ }
}
setInterval(checkDue, 20000);
setInterval(() => { if (view !== "tasks" || !document.activeElement?.matches("input,textarea")) render(); }, 60000);

// ------------------------------------------------------------------ toast + auth

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), Math.max(4000, msg.length * 70));
}

onAuthStateChanged(auth, u => {
  user = u;
  if (unsub) { unsub(); unsub = null; }
  tasks = new Map();
  $("#login").hidden = !!u;
  $("#appShell").hidden = !u;
  if (!u) return;
  $("#who").textContent = u.email;
  updateNotifyBtn();
  unsub = onSnapshot(collection(db, "users", u.uid, "tasks"), { includeMetadataChanges: true }, snap => {
    for (const ch of snap.docChanges()) {
      if (ch.type === "removed") { tasks.delete(ch.doc.id); continue; }
      try {
        const t = JSON.parse(ch.doc.data().json);
        const local = tasks.get(t.id);
        if (!local || t.updatedAt >= local.updatedAt) tasks.set(t.id, t);
      } catch { /* skip bad doc */ }
    }
    $("#syncState").textContent = snap.metadata.hasPendingWrites ? "Saving…" : snap.metadata.fromCache ? "Offline" : "Synced";
    // Don't redraw under the cursor while the user is typing in the detail panel.
    if (!document.activeElement?.dataset?.field) render();
  }, err => toast("Sync error: " + err.message));
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
