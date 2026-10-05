const state = {
  csrfToken: "",
  email: "",
  tools: [],
  selectedIds: new Set(),
  visibleIds: [],
  filter: "all",
  sort: "recent",
  view: "grid",
  toastTimer: null,
  maxUploadMb: 500
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function showOverlay(id) {
  $(`#${id}`).classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function hideOverlay(id) {
  $(`#${id}`).classList.add("hidden");
  if (!$$(".overlay:not(.hidden)").length) document.body.style.overflow = "";
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.style.borderColor = isError ? "#f0cbce" : "";
  toast.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

function setError(id, message) {
  const element = $(`#${id}`);
  element.textContent = message;
  element.classList.toggle("hidden", !message);
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.csrfToken && !["GET", "HEAD"].includes((options.method || "GET").toUpperCase())) {
    headers.set("X-CSRF-Token", state.csrfToken);
  }
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !url.endsWith("/api/login")) {
      state.csrfToken = "";
      showOverlay("loginOverlay");
    }
    throw new Error(body.error || "The request could not be completed.");
  }
  return body;
}

function bytesLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function dateLabel(date) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(date));
}

function safeText(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

function toolIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.8h7l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5.3a1.5 1.5 0 0 1 1-1.5Z"/><path d="M14 4v4h4M9 13h6M9 17h6"/></svg>';
}

function icon(name) {
  const icons = {
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6 4 4M4 20l4.2-.9L19 8.3a2.1 2.1 0 0 0-3-3L5.2 16.1 4 20Z"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 17v3h14v-3"/></svg>',
    delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9 7V4.5h6V7m-8 0 .8 13h8.4L17 7m-6 4v5m2 0v-5"/></svg>'
  };
  return icons[name];
}

function filteredTools() {
  const query = $("#searchInput").value.trim().toLowerCase();
  const tools = state.tools.filter((tool) => {
    const matchesQuery = `${tool.name} ${tool.originalName} ${tool.tags.join(" ")}`.toLowerCase().includes(query);
    return matchesQuery && (state.filter === "all" || tool.favorite);
  });
  const compareName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (state.sort === "name") tools.sort(compareName);
  else if (state.sort === "size") tools.sort((a, b) => b.size - a.size || compareName(a, b));
  else tools.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return tools;
}

function updateSelectionUI() {
  const selectedCount = state.selectedIds.size;
  $("#bulkToolbar").classList.toggle("hidden", selectedCount === 0);
  $("#selectionCount").textContent = `${selectedCount} selected`;
  const visibleIds = state.visibleIds;
  const selectedVisible = visibleIds.filter((id) => state.selectedIds.has(id)).length;
  $("#selectVisible").checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
  $("#selectVisible").indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  const selectedTools = state.tools.filter((tool) => state.selectedIds.has(tool.id));
  const allFavorite = selectedTools.length > 0 && selectedTools.every((tool) => tool.favorite);
  $("#bulkFavorite").innerHTML = `${allFavorite ? "☆ Unfavorite" : "★ Favorite"} selected`;
}

function renderTools() {
  const list = $("#toolList");
  const tools = filteredTools();
  state.visibleIds = tools.map((tool) => tool.id);
  $("#totalTools").textContent = state.tools.length;
  $("#navCount").textContent = state.tools.length;
  $("#collectionCount").textContent = `${state.tools.length} ${state.tools.length === 1 ? "item" : "items"}`;
  $("#allCount").textContent = state.tools.length;
  $("#favoriteCount").textContent = state.tools.filter((tool) => tool.favorite).length;
  $("#storageUsed").innerHTML = `${(state.tools.reduce((total, tool) => total + tool.size, 0) / (1024 * 1024)).toFixed(1)} <span>MB</span>`;
  if (state.tools.length) {
    $("#latestAddition").textContent = state.tools[0].name;
    $("#latestDate").textContent = `added ${dateLabel(state.tools[0].createdAt)}`;
  } else {
    $("#latestAddition").textContent = "—";
    $("#latestDate").textContent = "nothing uploaded yet";
  }
  $("#emptyState").classList.toggle("hidden", state.tools.length > 0 || state.filter !== "all");
  $("#toolList").classList.toggle("hidden", !tools.length);
  $("#noResults").classList.toggle("hidden", state.tools.length === 0 || tools.length > 0);
  $("#toolList").classList.toggle("list-view", state.view === "list");
  list.innerHTML = tools.map((tool) => `
    <article class="tool-card">
      <div class="card-topline">
        <label class="card-select" aria-label="Select ${safeText(tool.name)}"><input class="tool-select" type="checkbox" data-id="${safeText(tool.id)}" ${state.selectedIds.has(tool.id) ? "checked" : ""} /><span></span></label>
        <div class="file-icon">${toolIcon()}</div>
        <span class="file-type">${safeText(pathExtension(tool.originalName))}</span>
        <button class="row-button favorite-button ${tool.favorite ? "is-favorite" : ""}" type="button" data-action="favorite" data-id="${safeText(tool.id)}" title="${tool.favorite ? "Remove from favorites" : "Add to favorites"}" aria-label="${tool.favorite ? "Remove from favorites" : "Add to favorites"}">${icon("star")}</button>
      </div>
      <div class="tool-main">
        <div class="tool-copy"><strong title="${safeText(tool.name)}">${safeText(tool.name)}</strong><span title="${safeText(tool.originalName)}">${safeText(tool.originalName)}</span></div>
      </div>
      <div class="tool-tags">${tool.tags.length
        ? tool.tags.map((tag) => `<span class="tag-chip">${safeText(tag)}</span>`).join("")
        : '<span class="tag-placeholder">No tags yet</span>'}</div>
      <div class="card-meta"><span>${bytesLabel(tool.size)}</span><i></i><span>${dateLabel(tool.createdAt)}</span></div>
      <div class="card-actions">
        <button class="button button-card-download" type="button" data-action="download" data-id="${safeText(tool.id)}">${icon("download")} Download</button>
        <div class="card-icon-actions">
          <button class="row-button" type="button" data-action="edit" data-id="${safeText(tool.id)}" title="Edit name and tags" aria-label="Edit name and tags">${icon("edit")}</button>
          <button class="row-button delete" type="button" data-action="delete" data-id="${safeText(tool.id)}" title="Delete ${safeText(tool.name)}" aria-label="Delete ${safeText(tool.name)}">
            ${icon("delete")}
        </button>
      </div>
      </div>
    </article>
  `).join("");
  updateSelectionUI();
}

function pathExtension(filename) {
  const extension = filename.includes(".") ? filename.split(".").pop().toUpperCase() : "FILE";
  return extension.slice(0, 8);
}

async function loadTools() {
  state.tools = await request("/api/tools");
  renderTools();
}

function setSignedIn(email) {
  state.email = email;
  $("#profileEmail").textContent = email;
  $("#avatarInitial").textContent = email.charAt(0).toUpperCase();
  hideOverlay("loginOverlay");
}

async function initialize() {
  try {
    const config = await request("/api/config");
    state.maxUploadMb = config.maxUploadMb;
    $("#dropSubtitle").textContent = `Any file type · up to ${state.maxUploadMb} MB`;
    const me = await request("/api/me");
    state.csrfToken = me.csrfToken;
    $("#settingsEmail").value = me.email;
    setSignedIn(me.email);
    if (me.mustChangePassword) {
      showOverlay("settingsOverlay");
      $("#settingsTitle").textContent = "Make it yours.";
    } else {
      await loadTools();
    }
  } catch {
    showOverlay("loginOverlay");
  }
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("loginError", "");
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: $("#loginEmail").value,
        password: $("#loginPassword").value
      })
    });
    state.csrfToken = result.csrfToken;
    setSignedIn(result.email);
    $("#settingsEmail").value = result.email;
    $("#loginPassword").value = "";
    if (result.mustChangePassword) {
      $("#settingsTitle").textContent = "Make it yours.";
      showOverlay("settingsOverlay");
    } else {
      await loadTools();
    }
  } catch (error) {
    setError("loginError", error.message);
  } finally {
    button.disabled = false;
  }
});

$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("settingsError", "");
  $("#settingsSuccess").classList.add("hidden");
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await request("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: $("#settingsEmail").value,
        currentPassword: $("#currentPassword").value,
        password: $("#newPassword").value
      })
    });
    $("#currentPassword").value = "";
    $("#newPassword").value = "";
    $("#settingsSuccess").textContent = "Your sign-in details have been updated.";
    $("#settingsSuccess").classList.remove("hidden");
    setSignedIn(result.email);
    $("#settingsTitle").textContent = "Your sign-in.";
    await loadTools();
    window.setTimeout(() => hideOverlay("settingsOverlay"), 1000);
  } catch (error) {
    setError("settingsError", error.message);
  } finally {
    button.disabled = false;
  }
});

$("#uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("uploadError", "");
  const button = $("#submitUpload");
  button.disabled = true;
  button.textContent = "Uploading...";
  try {
    const body = new FormData();
    body.set("file", $("#toolFile").files[0]);
    body.set("name", $("#toolName").value);
    await request("/api/tools", { method: "POST", body });
    await loadTools();
    hideOverlay("uploadOverlay");
    event.currentTarget.reset();
    $("#dropTitle").textContent = "Choose a file or drop it here";
    $("#dropSubtitle").textContent = `Any file type · up to ${state.maxUploadMb} MB`;
    showToast("Your tool is safely tucked away.");
  } catch (error) {
    setError("uploadError", error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Upload to my library <span>→</span>';
  }
});

$("#toolList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  const tool = state.tools.find((item) => item.id === id);
  if (!tool) return;
  if (action === "favorite") {
    try {
      const updated = await request(`/api/tools/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite: !tool.favorite })
      });
      Object.assign(tool, updated);
      renderTools();
    } catch (error) {
      showToast(error.message, true);
    }
  } else if (action === "edit") {
    $("#editToolId").value = tool.id;
    $("#editToolName").value = tool.name;
    $("#editToolTags").value = tool.tags.join(", ");
    setError("editToolError", "");
    showOverlay("editToolOverlay");
    $("#editToolName").focus();
  } else if (action === "download") {
    try {
      const response = await fetch(`/api/tools/${encodeURIComponent(id)}/download`, { credentials: "same-origin" });
      if (!response.ok) throw new Error("Your download could not be started. Please sign in again.");
      const blob = await response.blob();
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = tool.originalName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    } catch (error) {
      showToast(error.message, true);
    }
  } else if (action === "delete") {
    if (!window.confirm(`Remove "${tool.name}" from your library? This can’t be undone.`)) return;
    try {
      await request(`/api/tools/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.tools = state.tools.filter((item) => item.id !== id);
      state.selectedIds.delete(id);
      renderTools();
      showToast("Tool removed from your library.");
    } catch (error) {
      showToast(error.message, true);
    }
  }
});

$("#toolList").addEventListener("change", (event) => {
  if (!event.target.matches(".tool-select")) return;
  const { id } = event.target.dataset;
  if (event.target.checked) state.selectedIds.add(id);
  else state.selectedIds.delete(id);
  updateSelectionUI();
});

$("#editToolForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("editToolError", "");
  const tags = $("#editToolTags").value.split(",").map((tag) => tag.trim()).filter(Boolean);
  const toolId = $("#editToolId").value;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const updated = await request(`/api/tools/${encodeURIComponent(toolId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("#editToolName").value, tags })
    });
    const tool = state.tools.find((item) => item.id === toolId);
    if (tool) Object.assign(tool, updated);
    renderTools();
    hideOverlay("editToolOverlay");
    showToast("Your changes have been saved.");
  } catch (error) {
    setError("editToolError", error.message);
  } finally {
    button.disabled = false;
  }
});

$("#bulkFavorite").addEventListener("click", async () => {
  const selected = state.tools.filter((tool) => state.selectedIds.has(tool.id));
  if (!selected.length) return;
  const favorite = !selected.every((tool) => tool.favorite);
  try {
    const updated = await Promise.all(selected.map((tool) => request(`/api/tools/${encodeURIComponent(tool.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favorite })
    })));
    updated.forEach((item) => Object.assign(state.tools.find((tool) => tool.id === item.id), item));
    renderTools();
    showToast(favorite ? "Selected tools added to favorites." : "Selected tools removed from favorites.");
  } catch (error) {
    await loadTools();
    showToast(`Some favorites could not be updated: ${error.message}`, true);
  }
});

$("#bulkDelete").addEventListener("click", async () => {
  const ids = [...state.selectedIds];
  if (!ids.length) return;
  if (!window.confirm(`Remove ${ids.length} selected ${ids.length === 1 ? "tool" : "tools"} from your library? This can’t be undone.`)) return;
  const button = $("#bulkDelete");
  button.disabled = true;
  try {
    const result = await request("/api/tools/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids })
    });
    const removed = new Set(result.deleted);
    state.tools = state.tools.filter((tool) => !removed.has(tool.id));
    result.deleted.forEach((id) => state.selectedIds.delete(id));
    renderTools();
    if (result.failed.length) {
      showToast(`${result.deleted.length} removed. ${result.failed.length} could not be removed.`, true);
    } else {
      showToast(`${result.deleted.length} ${result.deleted.length === 1 ? "tool" : "tools"} removed.`);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#selectVisible").addEventListener("change", (event) => {
  for (const id of state.visibleIds) {
    if (event.target.checked) state.selectedIds.add(id);
    else state.selectedIds.delete(id);
  }
  renderTools();
});

$("#uploadButton").addEventListener("click", () => showOverlay("uploadOverlay"));
$("#emptyUploadButton").addEventListener("click", () => showOverlay("uploadOverlay"));
$("#navUpload").addEventListener("click", () => showOverlay("uploadOverlay"));
$("#settingsButton").addEventListener("click", async () => {
  $("#settingsEmail").value = state.email;
  $("#settingsTitle").textContent = "Your sign-in.";
  $("#currentPassword").value = "";
  $("#newPassword").value = "";
  setError("settingsError", "");
  $("#settingsSuccess").classList.add("hidden");
  showOverlay("settingsOverlay");
});
$("#cliHelp").addEventListener("click", () => showOverlay("cliOverlay"));
$("#logoutButton").addEventListener("click", async () => {
  try {
    await request("/api/logout", { method: "POST" });
    state.csrfToken = "";
    state.tools = [];
    renderTools();
    showOverlay("loginOverlay");
    showToast("You’re signed out.");
  } catch (error) {
    showToast(error.message, true);
  }
});
$("#searchInput").addEventListener("input", renderTools);
$("#sortSelect").addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderTools();
});
$$(".filter-tab").forEach((button) => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  $$(".filter-tab").forEach((tab) => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  renderTools();
}));
$$(".view-button").forEach((button) => button.addEventListener("click", () => {
  state.view = button.dataset.view;
  $$(".view-button").forEach((viewButton) => viewButton.classList.toggle("active", viewButton === button));
  renderTools();
}));
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    $("#searchInput").focus();
  }
  if (event.key === "Escape") {
    const open = $(".overlay:not(.hidden)");
    if (open && open.id !== "loginOverlay") hideOverlay(open.id);
  }
});
$$("[data-close]").forEach((button) => button.addEventListener("click", () => hideOverlay(button.dataset.close)));
$$(".overlay").forEach((overlay) => overlay.addEventListener("click", (event) => {
  if (event.target === overlay && overlay.id !== "loginOverlay") hideOverlay(overlay.id);
}));
$("#toolFile").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $("#dropTitle").textContent = file.name;
  $("#dropSubtitle").textContent = bytesLabel(file.size);
});
$("#dropZone").addEventListener("dragover", (event) => {
  event.preventDefault();
  event.currentTarget.classList.add("dragging");
});
$("#dropZone").addEventListener("dragleave", (event) => event.currentTarget.classList.remove("dragging"));
$("#dropZone").addEventListener("drop", (event) => {
  event.preventDefault();
  event.currentTarget.classList.remove("dragging");
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const input = $("#toolFile");
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
});

initialize();
