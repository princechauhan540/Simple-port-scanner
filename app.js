"use strict";

const form = document.getElementById("scan-form");
const hostInput = document.getElementById("host");
const portsInput = document.getElementById("ports");
const timeoutInput = document.getElementById("timeout");
const startButton = document.getElementById("start-button");
const stopButton = document.getElementById("stop-button");
const exportButton = document.getElementById("export-button");
const body = document.getElementById("results-body");
const emptyState = document.getElementById("empty-state");
const progress = document.getElementById("scan-progress");
const stateLabel = document.getElementById("scan-state");
const scanMessage = document.getElementById("scan-message");
const filterAll = document.getElementById("filter-all");
const filterOpen = document.getElementById("filter-open");
const presets = [...document.querySelectorAll(".preset")];
const fileContext = location.protocol === "file:";
const results = [];
let controller = null;
let total = 0;
let activeHost = "";
let openOnly = false;

function setServerStatus(online) {
  document.getElementById("server-status").className = `server-status ${online ? "online" : "offline"}`;
  document.getElementById("server-label").textContent = online ? "Local server connected" : "Local server unavailable";
}

async function checkHealth() {
  if (fileContext) return;
  try {
    const response = await fetch("/api/health", { signal: AbortSignal.timeout(3000) });
    const health = await response.json();
    setServerStatus(response.ok && health.ok === true);
  } catch {
    setServerStatus(false);
  }
}

function setBusy(busy) {
  startButton.disabled = busy || fileContext;
  stopButton.disabled = !busy;
  hostInput.disabled = busy;
  portsInput.disabled = busy;
  timeoutInput.disabled = busy;
  presets.forEach(button => { button.disabled = busy; });
  document.getElementById("start-label").textContent = busy ? "Scanning…" : "Start scan";
  form.setAttribute("aria-busy", String(busy));
}

function setState(label, style, message) {
  stateLabel.textContent = label;
  stateLabel.className = `state-label ${style}`;
  scanMessage.textContent = message;
  scanMessage.classList.toggle("is-error", style === "error");
}

function updateCounts() {
  document.getElementById("checked-count").textContent = results.length;
  document.getElementById("open-count").textContent = results.filter(result => result.status === "open").length;
  document.getElementById("closed-count").textContent = results.filter(result => result.status === "closed").length;
  document.getElementById("timeout-count").textContent = results.filter(result => result.status === "timeout").length;
  document.getElementById("result-count").textContent = results.length;
  document.getElementById("progress-label").textContent = total ? `${results.length} of ${total} ports checked` : "Waiting to start";
  document.getElementById("progress-percent").textContent = `${total ? Math.round(results.length / total * 100) : 0}%`;
  progress.max = total || 1;
  progress.value = results.length;
  exportButton.disabled = results.length === 0;
}

function durationText(milliseconds) {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
}

function renderResults() {
  body.replaceChildren();
  const visible = results.filter(result => !openOnly || result.status === "open").sort((a, b) => a.port - b.port);
  for (const result of visible) {
    const row = document.createElement("tr");
    const portCell = document.createElement("td");
    portCell.textContent = result.port;
    const protocol = document.createElement("span");
    protocol.className = "port-protocol";
    protocol.textContent = "TCP";
    portCell.append(protocol);
    const serviceCell = document.createElement("td");
    serviceCell.textContent = result.service || "—";
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    const status = ["open", "closed", "timeout", "error"].includes(result.status) ? result.status : "error";
    badge.className = `result-status ${status}`;
    badge.textContent = { open: "Open", closed: "Closed", timeout: "Timed out", error: "Error" }[status];
    if (result.detail) badge.title = result.detail;
    statusCell.append(badge);
    const durationCell = document.createElement("td");
    durationCell.className = "time-cell";
    durationCell.textContent = durationText(result.durationMs);
    row.append(portCell, serviceCell, statusCell, durationCell);
    body.append(row);
  }
  emptyState.hidden = visible.length > 0;
  const filteredEmpty = openOnly && results.length > 0;
  document.getElementById("empty-title").textContent = filteredEmpty ? "No open ports found" : "Your results will appear here";
  document.getElementById("empty-copy").textContent = filteredEmpty ? "Switch to All ports to see every result." : "Start a scan to check your selected TCP ports.";
}

function selectFilter(onlyOpen) {
  openOnly = onlyOpen;
  filterAll.setAttribute("aria-pressed", String(!onlyOpen));
  filterOpen.setAttribute("aria-pressed", String(onlyOpen));
  renderResults();
}

async function readScan(response, onEvent) {
  if (!response.body) throw new Error("This browser does not support streaming scan results.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) onEvent(JSON.parse(line));
      }
      if (done) break;
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  } finally {
    reader.releaseLock();
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (controller || fileContext) return;
  const host = hostInput.value.trim();
  const ports = portsInput.value.trim();
  if (!host || !ports) {
    setState("Check inputs", "error", "Enter a target host and at least one port.");
    return;
  }
  results.length = 0;
  total = 0;
  activeHost = host;
  document.getElementById("scan-target").textContent = host;
  document.getElementById("scan-duration").textContent = "—";
  updateCounts();
  renderResults();
  controller = new AbortController();
  setBusy(true);
  setState("Scanning", "scanning", "Connecting to the target…");
  const started = performance.now();
  let completed = false;
  try {
    const response = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, ports, timeoutMs: Number(timeoutInput.value) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `The server returned an error (${response.status}).`);
    }
    setServerStatus(true);
    await readScan(response, data => {
      if (data.type === "start") {
        total = data.total;
        updateCounts();
        setState("Scanning", "scanning", `Checking TCP ports on ${host}.`);
      } else if (data.type === "result") {
        results.push(data);
        updateCounts();
        renderResults();
        document.getElementById("scan-duration").textContent = durationText(performance.now() - started);
      } else if (data.type === "done") {
        completed = true;
        stopButton.disabled = true;
        document.getElementById("scan-duration").textContent = durationText(data.elapsedMs);
        const errors = results.filter(result => result.status === "error").length;
        setState("Complete", "complete", `Scan complete. ${results.length} ports checked.${errors ? ` ${errors} connection errors.` : ""}`);
      } else if (data.type === "error") {
        throw new Error(data.error || data.message || "The scan could not be completed.");
      }
    });
    if (!completed) throw new Error("The connection ended before the scan completed. Try again.");
  } catch (error) {
    document.getElementById("scan-duration").textContent = durationText(performance.now() - started);
    if (error.name === "AbortError") {
      setState("Stopped", "", `Scan stopped. ${results.length} of ${total || "the selected"} ports checked.`);
    } else {
      const message = error instanceof TypeError
        ? "Could not reach the local server. Start it with node server.js and try again."
        : error.message || "The scan could not be completed. Try again.";
      setState("Scan failed", "error", message);
      checkHealth();
    }
  } finally {
    controller = null;
    setBusy(false);
  }
});

stopButton.addEventListener("click", () => {
  if (!controller) return;
  stopButton.disabled = true;
  setState("Stopping", "scanning", "Stopping the scan…");
  controller.abort();
});

presets.forEach(button => {
  button.addEventListener("click", () => { portsInput.value = button.dataset.ports; });
});
filterAll.addEventListener("click", () => selectFilter(false));
filterOpen.addEventListener("click", () => selectFilter(true));

exportButton.addEventListener("click", () => {
  if (!results.length) return;
  const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = [["Target", "Port", "Protocol", "Common service", "Status", "Response time (ms)"]];
  for (const result of [...results].sort((a, b) => a.port - b.port)) {
    rows.push([activeHost, result.port, "TCP", result.service || "", result.status, result.durationMs]);
  }
  const url = URL.createObjectURL(new Blob([rows.map(row => row.map(quote).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `port-scan-${activeHost.replace(/[^a-z0-9.-]/gi, "_")}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

if (fileContext) {
  setServerStatus(false);
  const notice = document.getElementById("environment-message");
  notice.textContent = "Run node server.js in the project folder, then open the localhost address printed in your terminal. The scanner needs its local server to test TCP connections.";
  notice.hidden = false;
  setBusy(false);
} else {
  checkHealth();
}
