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

document.addEventListener("DOMContentLoaded", () => {
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
