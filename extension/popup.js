let wasConnected = false;

async function refreshStatus() {
  const res = await chrome.runtime.sendMessage({ type: "get-status" }).catch(() => null);
  const pill = document.getElementById("status");
  const dot = document.getElementById("status-dot");
  const label = document.getElementById("status-label");
  const text = document.getElementById("status-text");
  const statPid = document.getElementById("stat-pid");
  const statSessions = document.getElementById("stat-sessions");
  const statVersion = document.getElementById("stat-version");
  const portInput = document.getElementById("port");

  for (const el of [pill, dot]) el.classList.remove("connected", "disconnected");

  const isConnected = !!res?.connected;
  const state = isConnected ? "connected" : "disconnected";
  pill.classList.add(state);
  dot.classList.add(state);
  label.textContent = isConnected ? "Connected" : "Disconnected";

  if (isConnected) {
    const sessions = typeof res.peers === "number" ? res.peers + 1 : null;
    text.textContent = `127.0.0.1:${res.port}`;
    statSessions.textContent = sessions === null ? "—" : String(sessions);
    statVersion.textContent = res.hubVersion ? `v${res.hubVersion}` : "—";
    statPid.textContent = res.hubPid ? String(res.hubPid) : "—";
    const hubInfo = res.hubPid ? `Hub: server pid ${res.hubPid} (v${res.hubVersion})` : "";
    pill.title = hubInfo;
    statVersion.title = hubInfo;
  } else {
    text.textContent = `Nothing on port ${res?.port ?? "?"}`;
    statPid.textContent = "—";
    statSessions.textContent = "0";
    statVersion.textContent = "—";
    pill.title = "";
    statVersion.title = "";
  }

  if (portInput && document.activeElement !== portInput) {
    portInput.value = res?.port ?? 47615;
  }

  // The client list is only fetchable while connected. Re-fetch it whenever
  // we transition from disconnected -> connected (e.g. the server just
  // (re)started), instead of leaving a stale/empty list from before.
  if (isConnected && !wasConnected) refreshClients();
  wasConnected = isConnected;
}

// ---------------------------------------------------------------------------
// MCP client installer: lists locally detected MCP clients (via the server,
// over the existing WebSocket) and lets the user install/uninstall the
// webmcp server entry in each one with a single click.
// ---------------------------------------------------------------------------

let clientActionInFlight = false;

function renderClients(clients) {
  const list = document.getElementById("client-list");
  list.innerHTML = "";

  if (!clients || clients.length === 0) {
    const li = document.createElement("li");
    li.className = "client-empty";
    li.textContent = "No known MCP clients found on this machine.";
    list.appendChild(li);
    return;
  }

  for (const client of clients) {
    const li = document.createElement("li");
    li.className = "client-row";

    const info = document.createElement("div");
    info.className = "client-info";

    const name = document.createElement("div");
    name.className = "client-name" + (client.detected ? "" : " not-detected");
    name.textContent = client.name;

    const pathEl = document.createElement("div");
    pathEl.className = "client-path";
    pathEl.title = client.configPath;
    pathEl.textContent = client.detected ? client.configPath : "Not detected";

    info.appendChild(name);
    info.appendChild(pathEl);

    const action = document.createElement("button");
    action.className = "client-action" + (client.installed ? " installed" : "");
    action.textContent = client.installed ? "Uninstall" : "Install";
    action.disabled = !client.detected;
    action.addEventListener("click", () => onClientAction(client));

    li.appendChild(info);
    li.appendChild(action);
    list.appendChild(li);
  }
}

async function refreshClients() {
  const list = document.getElementById("client-list");
  const res = await chrome.runtime.sendMessage({ type: "list-clients" }).catch((err) => ({
    ok: false,
    error: err?.message,
  }));

  if (!res?.ok) {
    list.innerHTML = "";
    const li = document.createElement("li");
    li.className = "client-empty";
    li.textContent = res?.error || "Connect to the server to detect clients.";
    list.appendChild(li);
    return;
  }

  renderClients(res.clients);
}

function showClientError(message) {
  const list = document.getElementById("client-list");
  let errEl = document.getElementById("client-error");
  if (!message) {
    errEl?.remove();
    return;
  }
  if (!errEl) {
    errEl = document.createElement("div");
    errEl.id = "client-error";
    errEl.className = "client-error";
    list.insertAdjacentElement("afterend", errEl);
  }
  errEl.textContent = message;
}

async function onClientAction(client) {
  if (clientActionInFlight) return;
  clientActionInFlight = true;
  showClientError(null);
  try {
    const type = client.installed ? "uninstall-client" : "install-client";
    const res = await chrome.runtime.sendMessage({ type, id: client.id });
    if (!res?.ok) {
      showClientError(res?.error || "Action failed.");
    }
    await refreshClients();
  } finally {
    clientActionInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Settings: the agent cursor toggle and the site policy (chrome.storage.local,
// read by the service worker on every request).
// ---------------------------------------------------------------------------

const RU = /^ru\b/i.test(navigator.language || "");
const I18N = {
  cursorTitle: ["Show cursor & highlight", "Показывать курсор и подсветку"],
  cursorHint: [
    "The agent's cursor glides to each element and outlines what it works on.",
    "Курсор агента плавно подводится к элементам и обводит то, с чем он работает.",
  ],
  policyTitle: ["Site access", "Доступ к сайтам"],
  policyDefault: ["Other sites: full", "Остальные сайты: полный"],
  modeFull: ["Full", "Полный"],
  modeReadOnly: ["Read-only", "Только чтение"],
  modeBlocked: ["Blocked", "Запрещён"],
  add: ["Add", "Добавить"],
  remove: ["Remove", "Удалить"],
  policyHint: [
    "Read-only: agents can read, scroll and screenshot, but not click, type, run scripts or send non-GET requests. Blocked: nothing but listing tabs. A domain covers its subdomains.",
    "Только чтение: агент читает, прокручивает и делает снимки, но не нажимает, не вводит текст, не запускает скрипты и не шлёт запросы кроме GET. Запрещён: только список вкладок. Домен включает поддомены.",
  ],
  badPattern: ["Enter a host like x.com or *.example.com.", "Введите домен, например x.com или *.example.com."],
};
const tr = (key) => (I18N[key] ? I18N[key][RU ? 1 : 0] : key);
const MODES = ["full", "read-only", "blocked"];
const MODE_KEYS = { full: "modeFull", "read-only": "modeReadOnly", blocked: "modeBlocked" };

function translatePage() {
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = tr(el.dataset.i18n);
}

// "https://www.x.com/home" -> "www.x.com"; "*.x.com" stays.
function normalizePattern(raw) {
  let s = String(raw || "").trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  if (s === "*") return s;
  const host = s.startsWith("*.") ? s.slice(2) : s;
  // Letters (incl. IDN), digits and hyphens in dot-separated labels, or an IP.
  if (!/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*$|^\[?[0-9a-f:.]+\]?$/u.test(host)) return null;
  return s;
}

async function loadPolicy() {
  const { sitePolicy } = await chrome.storage.local.get("sitePolicy");
  return Array.isArray(sitePolicy) ? sitePolicy : [];
}

async function savePolicy(rules) {
  await chrome.storage.local.set({ sitePolicy: rules });
  renderPolicy(rules);
}

function modeSelect(value, onChange) {
  const select = document.createElement("select");
  select.className = `policy-select mode-${value}`;
  for (const mode of MODES) {
    const opt = document.createElement("option");
    opt.value = mode;
    opt.textContent = tr(MODE_KEYS[mode]);
    select.appendChild(opt);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function renderPolicy(rules) {
  const list = document.getElementById("policy-list");
  list.innerHTML = "";
  rules.forEach((rule, i) => {
    const li = document.createElement("li");
    li.className = "policy-row";
    const pattern = document.createElement("span");
    pattern.className = "policy-pattern mono";
    pattern.textContent = rule.pattern;
    pattern.title = rule.pattern;
    const select = modeSelect(rule.mode, async (mode) => {
      const next = await loadPolicy();
      if (next[i]) next[i] = { ...next[i], mode };
      await savePolicy(next);
    });
    const remove = document.createElement("button");
    remove.className = "policy-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = tr("remove");
    remove.setAttribute("aria-label", `${tr("remove")} ${rule.pattern}`);
    remove.addEventListener("click", async () => {
      const next = await loadPolicy();
      next.splice(i, 1);
      await savePolicy(next);
    });
    li.append(pattern, select, remove);
    list.appendChild(li);
  });
}

async function initSettings() {
  translatePage();
  const toggle = document.getElementById("show-cursor");
  const { showCursor } = await chrome.storage.local.get("showCursor");
  toggle.checked = showCursor !== false;
  toggle.addEventListener("change", () => chrome.storage.local.set({ showCursor: toggle.checked }));

  renderPolicy(await loadPolicy());
  const form = document.getElementById("policy-form");
  const input = document.getElementById("policy-pattern");
  const err = document.getElementById("policy-error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const pattern = normalizePattern(input.value);
    if (!pattern) {
      err.textContent = tr("badPattern");
      err.hidden = false;
      return;
    }
    err.hidden = true;
    const mode = document.getElementById("policy-mode").value;
    const rules = (await loadPolicy()).filter((r) => r.pattern !== pattern);
    rules.push({ pattern, mode });
    await savePolicy(rules);
    input.value = "";
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initSettings();
  document.getElementById("ext-version").textContent = `v${chrome.runtime.getManifest().version}`;
  refreshStatus();
  refreshClients();

  document.getElementById("save").addEventListener("click", async () => {
    const port = Number(document.getElementById("port").value) || 47615;
    await chrome.runtime.sendMessage({ type: "set-port", port });
    refreshStatus();
  });

  document.getElementById("reconnect").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "reconnect" });
    setTimeout(refreshStatus, 500);
    setTimeout(refreshClients, 500);
  });

  document.getElementById("refresh-clients").addEventListener("click", refreshClients);

  setInterval(refreshStatus, 2000);
});
