(function ruizhiPageEnhanceModule(globalScope) {
  function installRuizhiPageEnhance(env = {}) {
  const window = env.window || globalScope.window;
  const document = env.document || window?.document || globalScope.document;
  if (!window || !document) return null;
  function isCodexLoginPage() {
    const locationText = [
      window.location?.pathname,
      window.location?.hash,
      window.location?.href
    ].filter(Boolean).join(" ");
    if (/(^|[/?#])(login|onboarding|sign-?in)([/?#]|$)/i.test(locationText)) return true;
    if (document.querySelector("[data-thread-find-target='conversation'],[data-app-action-sidebar-thread-row],nav[role='navigation']")) return false;
    const bodyText = (document.body?.textContent || "").replace(/\s+/g, " ").trim();
    return /\b(Welcome to Codex|Get started with Codex|Sign in with ChatGPT|Continue with ChatGPT|OpenAI API key)\b/i.test(bodyText);
  }
  if (isCodexLoginPage()) return null;
  if (env.ruizhiDesktop && !window.ruizhiDesktop) {
    try {
      window.ruizhiDesktop = env.ruizhiDesktop;
    } catch {
    }
  }
  if (env.config) {
    try {
      window.__RUIZHI_PAGE_ENHANCE_CONFIG__ = env.config;
    } catch {
    }
  }
  const runtimeKey = "__RUIZHI_PAGE_ENHANCE_RUNTIME__";
  const previous = window[runtimeKey];
  if (previous && typeof previous.dispose === "function") previous.dispose();

  const markers = {
    pluginEntry: "RUIZHI_PLUGIN_ENTRY_UNLOCK_V1",
    forcePluginInstall: "RUIZHI_FORCE_PLUGIN_INSTALL_V1",
    sessionActions: "RUIZHI_SESSION_ACTIONS_V1",
    timeline: "RUIZHI_CONVERSATION_TIMELINE_V1",
    threadScroll: "RUIZHI_THREAD_SCROLL_RESTORE_V1",
    threadSort: "RUIZHI_THREAD_SORT_FIX_V1",
    settingsVersion: "RUIZHI_SETTINGS_VERSION_FIX_V1"
  };
  window.__RUIZHI_PAGE_ENHANCE_MARKERS__ = markers;

  const defaultFeatures = {
    menu: false,
    pluginEntryUnlock: true,
    forcePluginInstall: true,
    sessionDelete: false,
    markdownExport: true,
    projectMove: false,
    timeline: true,
    threadScrollRestore: true,
    threadSort: true,
    modelWhitelistUnlock: false,
    zedRemoteOpen: false,
    upstreamWorktreeCreate: false,
    serviceTierControls: false
  };

  const cleanup = [];
  const state = {
    disposed: false,
    settings: normalizeSettings(window.__RUIZHI_PAGE_ENHANCE_CONFIG__ || {}),
    scanTimer: null,
    observer: null,
    forcePluginTimer: null,
    scrollSaveTimer: null,
    scrollBoundElements: new WeakSet(),
    scrollRestoreKey: "",
    sortRequestKey: "",
    sortRequestTime: 0
  };

  window[runtimeKey] = { dispose, scan };

  function normalizeSettings(value) {
    const features = value && typeof value === "object" && value.features && typeof value.features === "object" ? value.features : {};
    return {
      enabled: value?.enabled !== false,
      features: { ...defaultFeatures, ...features, menu: false, sessionDelete: false, projectMove: false },
      appVersion: typeof value?.appVersion === "string" ? value.appVersion.trim() : "",
      appDisplayVersion: typeof value?.appDisplayVersion === "string" ? value.appDisplayVersion.trim() : ""
    };
  }

  function feature(name) {
    return state.settings.enabled !== false && state.settings.features[name] !== false;
  }

  function bridgeCall(route, payload) {
    const enhance = window.ruizhiDesktop && window.ruizhiDesktop.enhance;
    if (!enhance || typeof enhance.call !== "function") {
      return Promise.resolve({ status: "failed", message: "增强 bridge 不可用" });
    }
    return enhance.call(route, payload || {});
  }

  function on(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    cleanup.push(() => target.removeEventListener(event, handler, options));
  }

  function dispose() {
    state.disposed = true;
    if (state.scanTimer) clearTimeout(state.scanTimer);
    if (state.forcePluginTimer) clearInterval(state.forcePluginTimer);
    if (state.scrollSaveTimer) clearTimeout(state.scrollSaveTimer);
    if (state.observer) state.observer.disconnect();
    while (cleanup.length) {
      try {
        cleanup.pop()();
      } catch {
      }
    }
    document.querySelectorAll("#ruizhi-page-enhance-style,#ruizhi-page-enhance-menu,.ruizhi-enhance-toast,.ruizhi-conversation-timeline").forEach((node) => node.remove());
    document.querySelectorAll(".ruizhi-session-actions").forEach((node) => node.remove());
  }

  function injectStyle() {
    if (document.getElementById("ruizhi-page-enhance-style")) return;
    const style = document.createElement("style");
    style.id = "ruizhi-page-enhance-style";
    style.textContent = `
      #ruizhi-page-enhance-menu{position:fixed;right:14px;bottom:14px;z-index:99998;font:13px system-ui,sans-serif;color:var(--token-text-primary,var(--token-foreground,#0d0d0d))}
      #ruizhi-page-enhance-menu [data-trigger]{border:1px solid var(--token-border-light,var(--token-border,#d9d9e3));border-radius:7px;background:var(--token-main-surface-secondary,var(--token-main-surface-primary,#fff));color:var(--token-text-primary,var(--token-foreground,#0d0d0d));padding:7px 10px;box-shadow:0 8px 24px rgba(0,0,0,.12);cursor:pointer}
      #ruizhi-page-enhance-menu [data-trigger]:hover{background:var(--token-main-surface-tertiary,rgba(127,127,127,.10))}
      #ruizhi-page-enhance-menu [data-trigger]:focus-visible{outline:0;box-shadow:0 0 0 2px var(--token-focus-border,rgba(16,163,127,.35)),0 8px 24px rgba(0,0,0,.12)}
      #ruizhi-page-enhance-menu [data-panel]{position:absolute;right:0;bottom:38px;min-width:220px;border:1px solid var(--token-border-light,var(--token-border,#d9d9e3));border-radius:8px;background:var(--token-main-surface-primary,#fff);color:var(--token-text-primary,var(--token-foreground,#0d0d0d));box-shadow:0 16px 40px rgba(0,0,0,.16);padding:8px;display:none}
      #ruizhi-page-enhance-menu[data-open="true"] [data-panel]{display:grid;gap:6px}
      #ruizhi-page-enhance-menu label{display:flex;align-items:center;justify-content:space-between;gap:12px;color:inherit;padding:3px 2px}
      #ruizhi-page-enhance-menu input[type="checkbox"]{accent-color:var(--token-text-link-foreground,#1f6feb);width:16px;height:16px}
      .ruizhi-enhance-toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;max-width:min(560px,calc(100vw - 32px));border-radius:8px;background:#111827;color:#fff;padding:10px 12px;font:13px system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.25)}
      .ruizhi-enhance-toast button{margin-left:10px;color:#93c5fd;background:transparent;border:0;cursor:pointer}
      .ruizhi-session-actions{position:absolute;right:72px;top:50%;transform:translateY(-50%);display:flex;gap:4px;opacity:0;z-index:1;pointer-events:none}
      [data-ruizhi-session-row="true"]{position:relative}
      [data-ruizhi-session-row="true"]:hover .ruizhi-session-actions,.ruizhi-session-actions:focus-within{opacity:1}
      .ruizhi-session-actions button{width:20px;height:20px;display:grid;place-items:center;border:1px solid rgba(127,127,127,.35);border-radius:5px;background:var(--token-main-surface-primary,#fff);color:inherit;cursor:pointer;padding:0;font-size:11px;line-height:1;pointer-events:auto}
      .codex-force-install-unlocked{pointer-events:auto!important;cursor:pointer!important;opacity:1!important}
      .ruizhi-conversation-timeline{position:fixed;right:8px;top:96px;bottom:96px;width:18px;z-index:9999}
      .ruizhi-conversation-timeline-track{position:absolute;left:8px;top:0;bottom:0;width:2px;background:rgba(127,127,127,.3)}
      .ruizhi-conversation-timeline-marker{position:absolute;left:3px;width:12px;height:12px;border-radius:999px;border:2px solid #10a37f;background:var(--token-main-surface-primary,#fff);cursor:pointer}
      .ruizhi-conversation-timeline-marker span{display:none;position:absolute;right:18px;top:-8px;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:6px;background:#111827;color:#fff;padding:6px 8px;font:12px system-ui,sans-serif}
      .ruizhi-conversation-timeline-marker:hover span{display:block}
      .ruizhi-timeline-target{outline:2px solid rgba(16,163,127,.7);outline-offset:4px;border-radius:6px}
      .ruizhi-footer-version-badge{display:inline-flex;align-items:center;min-height:28px;padding:0 8px;color:var(--token-text-tertiary,var(--token-text-secondary,#6b7280));font:12px system-ui,sans-serif;white-space:nowrap}
    `;
    document.head.appendChild(style);
  }

  function toast(message, undoToken) {
    document.querySelectorAll(".ruizhi-enhance-toast").forEach((node) => node.remove());
    const node = document.createElement("div");
    node.className = "ruizhi-enhance-toast";
    node.textContent = message;
    if (undoToken) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "撤销";
      button.addEventListener("click", async () => {
        const result = await bridgeCall("/undo", { undo_token: undoToken });
        toast(result.message || (result.status === "undone" ? "已撤销" : "撤销失败"));
        scheduleScan();
      });
      node.appendChild(button);
    }
    document.body.appendChild(node);
    setTimeout(() => node.remove(), undoToken ? 8000 : 3200);
  }

  function renderMenu() {
    if (!feature("menu")) return;
    if (document.getElementById("ruizhi-page-enhance-menu")) return;
    const root = document.createElement("div");
    root.id = "ruizhi-page-enhance-menu";
    root.innerHTML = `
      <button type="button" data-trigger>锐捷增强</button>
      <div data-panel>
        <label>插件入口<input type="checkbox" data-feature="pluginEntryUnlock"></label>
        <label>强制安装<input type="checkbox" data-feature="forcePluginInstall"></label>
        <label>Markdown<input type="checkbox" data-feature="markdownExport"></label>
        <label>Timeline<input type="checkbox" data-feature="timeline"></label>
        <label>滚动恢复<input type="checkbox" data-feature="threadScrollRestore"></label>
        <label>排序修正<input type="checkbox" data-feature="threadSort"></label>
      </div>
    `;
    root.querySelector("[data-trigger]").addEventListener("click", () => {
      root.dataset.open = root.dataset.open === "true" ? "false" : "true";
    });
    root.querySelectorAll("[data-feature]").forEach((input) => {
      const name = input.dataset.feature;
      input.checked = feature(name);
      input.addEventListener("change", async () => {
        state.settings.features[name] = input.checked;
        await bridgeCall("/settings/set", { features: { [name]: input.checked } });
        scheduleScan();
      });
    });
    document.body.appendChild(root);
  }

  function pluginEntryButton() {
    const buttons = Array.from(document.querySelectorAll("nav[role='navigation'] button, nav button, [role='navigation'] button"));
    return buttons.find((button) => /^(插件|Plugins)(\s+-\s+.*)?$/i.test((button.textContent || "").trim())) || null;
  }

  function enablePluginEntry() {
    if (!feature("pluginEntryUnlock")) return;
    const button = pluginEntryButton();
    if (!button) return;
    button.dataset.ruizhiPluginEntryUnlock = markers.pluginEntry;
    clearDisabledState(button);
    const textNode = Array.from(button.querySelectorAll("span,div")).reverse()
      .flatMap((node) => Array.from(node.childNodes))
      .find((node) => node.nodeType === 3 && /^(插件|Plugins)(\s+-\s+.*)?$/i.test((node.nodeValue || "").trim()));
    if (textNode) textNode.nodeValue = /^Plugins/i.test(textNode.nodeValue || "") ? "Plugins" : "插件";
    if (button.dataset.ruizhiPluginEntryBound !== "true") {
      button.dataset.ruizhiPluginEntryBound = "true";
    }
  }

  function pluginInstallCandidates() {
    const selector = "button:disabled,button[aria-disabled='true'],[role='button'][aria-disabled='true'],button[data-disabled],[role='button'][data-disabled],button.cursor-not-allowed,[role='button'].cursor-not-allowed,button.pointer-events-none,[role='button'].pointer-events-none";
    return Array.from(new Set(Array.from(document.querySelectorAll(selector)).map((node) => node.closest("button,[role='button']") || node)));
  }

  function isInstallButton(element) {
    const text = (element.textContent || "").trim();
    return /^安装\s*/.test(text) || /^Install\s*/i.test(text) || text === "强制安装" || /即将支持|敬请期待/.test(text);
  }

  function patchReactDisabledProps(element) {
    Object.keys(element).filter((key) => key.startsWith("__reactProps")).forEach((key) => {
      const props = element[key];
      if (!props || typeof props !== "object") return;
      props.disabled = false;
      props["aria-disabled"] = false;
      props["data-disabled"] = undefined;
    });
  }

  function clearDisabledState(element) {
    if (!(element instanceof HTMLElement)) return;
    if ("disabled" in element) element.disabled = false;
    element.removeAttribute("disabled");
    element.removeAttribute("aria-disabled");
    element.removeAttribute("data-disabled");
    element.removeAttribute("inert");
    element.classList.remove("disabled", "opacity-50", "cursor-not-allowed", "pointer-events-none");
    element.classList.add("codex-force-install-unlocked");
    element.style.pointerEvents = "auto";
    element.style.opacity = "";
    element.style.cursor = "pointer";
    element.tabIndex = 0;
    patchReactDisabledProps(element);
  }

  function unlockNodes(button) {
    const nodes = [button];
    button.querySelectorAll("button,[role='button'],[disabled],[aria-disabled],[data-disabled],.cursor-not-allowed,.pointer-events-none").forEach((node) => nodes.push(node));
    for (let parent = button.parentElement, depth = 0; parent && depth < 3; parent = parent.parentElement, depth += 1) {
      if (parent.matches("button,[role='button'],[disabled],[aria-disabled],[data-disabled],.cursor-not-allowed,.pointer-events-none")) nodes.push(parent);
    }
    return Array.from(new Set(nodes));
  }

  function labelForcedInstallButton(button) {
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.nodeValue || "").trim();
      if (/^安装\s*/.test(text) || /^Install\s*/i.test(text) || /即将支持|敬请期待/.test(text)) {
        node.nodeValue = "强制安装";
        return;
      }
    }
  }

  function unblockPluginInstallButtons() {
    if (!feature("forcePluginInstall")) return;
    pluginInstallCandidates().forEach((button) => {
      if (!isInstallButton(button)) return;
      button.dataset.ruizhiForcePluginInstall = markers.forcePluginInstall;
      unlockNodes(button).forEach(clearDisabledState);
      labelForcedInstallButton(button);
      if (button.dataset.ruizhiForceInstallBound !== "true") {
        button.dataset.ruizhiForceInstallBound = "true";
        ["pointerdown", "mousedown", "mouseup", "click", "focus"].forEach((eventName) => {
          button.addEventListener(eventName, () => unlockNodes(button).forEach(clearDisabledState), true);
        });
      }
    });
    if (!state.forcePluginTimer) {
      state.forcePluginTimer = setInterval(() => {
        if (!feature("forcePluginInstall")) {
          clearInterval(state.forcePluginTimer);
          state.forcePluginTimer = null;
          return;
        }
        unblockPluginInstallButtons();
      }, 1200);
    }
  }

  function closestSessionRow(node) {
    if (!(node instanceof HTMLElement)) return null;
    const row = node.closest([
      "[data-app-action-sidebar-thread-id]",
      "[data-app-action-sidebar-thread-row]",
      "[data-app-action-sidebar-thread-title]",
      "[data-thread-id]",
      "[data-session-id]",
      "[data-testid*='thread']",
      "[data-testid*='conversation']",
      "[data-testid*='chat-history']",
      "a[href*='/c/']",
      "a[href*='thread']",
      "a[href*='conversation']",
      "li",
      "[role='listitem']"
    ].join(","));
    if (!(row instanceof HTMLElement) || row.closest(".ruizhi-session-actions")) return null;
    const rect = row.getBoundingClientRect();
    if (rect.width < 32 || rect.height < 18) return null;
    if (row.matches("main,body,html,[role='main']")) return null;
    return stableSessionIdFromElement(row) ? row : null;
  }

  function stableSessionIdFromElement(row) {
    const direct = row.getAttribute("data-app-action-sidebar-thread-id")
      || row.getAttribute("data-app-action-sidebar-thread-row")
      || row.getAttribute("data-thread-id")
      || row.getAttribute("data-session-id")
      || row.dataset.threadId
      || row.dataset.sessionId
      || "";
    if (direct) return direct.replace(/^local:/, "");
    const linked = row.matches("a[href]") ? row : row.querySelector("a[href*='/c/'],a[href*='thread'],a[href*='conversation']");
    const href = linked?.getAttribute("href") || "";
    const match = href.match(/\/(?:c|thread|threads|conversation|conversations|chat)\/([^/?#]+)/i) || href.match(/(?:thread|conversation)[=/]([^&#?/]+)/i);
    if (match?.[1]) return decodeURIComponent(match[1]).replace(/^local:/, "");
    const nested = row.querySelector("[data-app-action-sidebar-thread-id],[data-app-action-sidebar-thread-row],[data-thread-id],[data-session-id]");
    if (nested instanceof HTMLElement) return stableSessionIdFromElement(nested);
    const testId = row.getAttribute("data-testid") || "";
    const idMatch = testId.match(/(?:thread|conversation|session)[-_:/]([A-Za-z0-9._:-]{8,})/i);
    return idMatch?.[1] || "";
  }

  function sessionRows() {
    const selector = [
      "[data-app-action-sidebar-thread-id]",
      "[data-app-action-sidebar-thread-row]",
      "[data-app-action-sidebar-thread-title]",
      "[data-thread-id]",
      "[data-session-id]",
      "[data-testid*='thread']",
      "[data-testid*='conversation']",
      "[data-testid*='chat-history']",
      "a[href*='/c/']",
      "a[href*='thread']",
      "a[href*='conversation']"
    ].join(",");
    const rows = [];
    for (const node of document.querySelectorAll(selector)) {
      const row = closestSessionRow(node);
      if (row && !rows.includes(row)) rows.push(row);
    }
    return rows;
  }

  function sessionRefFromRow(row) {
    const id = stableSessionIdFromElement(row);
    const titleNode = row.querySelector("[data-app-action-sidebar-thread-title],[data-thread-title],[data-testid*='title'],[title]");
    const title = (row.getAttribute("data-app-action-sidebar-thread-title") || titleNode?.getAttribute("title") || titleNode?.textContent || row.getAttribute("aria-label") || row.title || row.textContent || "Untitled session")
      .replace(/删除|导出|移动|排序修正/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    return { session_id: id, title };
  }

  function installSessionActions() {
    if (!feature("markdownExport")) return;
    sessionRows().forEach((row) => {
      if (row.querySelector(".ruizhi-session-actions")) return;
      const ref = sessionRefFromRow(row);
      if (!ref.session_id) return;
      row.dataset.ruizhiSessionRow = "true";
      const group = document.createElement("div");
      group.className = "ruizhi-session-actions";
      group.dataset.ruizhiSessionActions = markers.sessionActions;
      if (feature("markdownExport")) group.appendChild(actionButton("导出", "⇩", () => exportMarkdown(ref)));
      row.appendChild(group);
    });
  }

  function commonSessionListParent(rows) {
    const counts = new Map();
    for (const row of rows) {
      for (let parent = row.parentElement, depth = 0; parent && depth < 4; parent = parent.parentElement, depth += 1) {
        counts.set(parent, (counts.get(parent) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .filter(([, count]) => count >= Math.min(rows.length, 2))
      .sort((left, right) => right[1] - left[1])[0]?.[0] || null;
  }

  function installThreadSorting() {
    if (!feature("threadSort")) return;
    const rows = sessionRows();
    if (rows.length < 2) return;
    const sessions = rows.map(sessionRefFromRow).filter((ref) => ref.session_id);
    if (sessions.length < 2) return;
    const requestKey = sessions.map((session) => session.session_id).join("|");
    const now = Date.now();
    if (state.sortRequestKey === requestKey && now - state.sortRequestTime < 5000) return;
    state.sortRequestKey = requestKey;
    state.sortRequestTime = now;
    bridgeCall("/thread-sort-keys", { sessions }).then((result) => {
      if (state.disposed || result?.status !== "ok" || !Array.isArray(result.sort_keys)) return;
      const sortKeys = new Map(result.sort_keys.map((item) => [String(item.session_id || ""), Number(item.updated_at_ms || item.updated_at || item.archived_at || 0)]));
      rows.forEach((row) => {
        const key = sortKeys.get(sessionRefFromRow(row).session_id);
        if (Number.isFinite(key) && key > 0) row.setAttribute("data-ruizhi-sort-key", String(key));
      });
      const sortableRows = rows.filter((row) => Number(row.getAttribute("data-ruizhi-sort-key")) > 0);
      const container = commonSessionListParent(sortableRows);
      if (!container || sortableRows.length < 2) return;
      const ordered = sortableRows.slice().sort((left, right) => Number(right.getAttribute("data-ruizhi-sort-key")) - Number(left.getAttribute("data-ruizhi-sort-key")));
      let changed = false;
      for (let index = 0; index < ordered.length; index += 1) {
        if (sortableRows[index] !== ordered[index]) changed = true;
      }
      if (!changed) return;
      ordered.forEach((row) => {
        if (row.parentElement === container) container.appendChild(row);
      });
    }).catch((error) => bridgeCall("/diagnostics/log", { event: "thread_sort_failed", message: String(error?.message || error) }));
  }

  function actionButton(label, content, handler, html = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    if (html) button.innerHTML = content;
    else button.textContent = content;
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((eventName) => {
      button.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      }, true);
    });
    button.addEventListener("click", handler, true);
    return button;
  }

  async function exportMarkdown(ref) {
    const result = await bridgeCall("/export-markdown", ref);
    if (result.status === "exported" && result.filename && typeof result.markdown === "string") {
      const url = URL.createObjectURL(new Blob([result.markdown], { type: "text/markdown;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    toast(result.message || "导出失败");
  }

  function timelineRoot() {
    return document.querySelector("main") || document.querySelector("[role='main']") || document.body;
  }

  function timelineQuestions() {
    const root = timelineRoot();
    const candidates = Array.from(root.querySelectorAll("[data-turn-key],[data-content-search-turn-key],[data-message-author-role='user'],[data-testid*='user'],[data-testid*='conversation-turn'],[data-testid*='message'],article,[role='article']"));
    return candidates.filter((node) => {
      const text = timelineLabel(node);
      const rect = node.getBoundingClientRect();
      return text.length > 0 && text.length < 1200 && rect.height > 0 && messageAuthorOf(node) === "user";
    }).slice(0, 40);
  }

  function messageAuthorOf(node) {
    const direct = node.getAttribute("data-message-author-role") || node.getAttribute("data-author") || "";
    if (/^user$/i.test(direct)) return "user";
    if (/^assistant$/i.test(direct)) return "assistant";
    if (node.hasAttribute("data-turn-key") || node.hasAttribute("data-content-search-turn-key")) return "user";
    const nested = node.querySelector?.("[data-message-author-role]");
    if (nested instanceof HTMLElement) return messageAuthorOf(nested);
    const text = [
      node.getAttribute("data-testid"),
      node.getAttribute("aria-label"),
      node.getAttribute("class")
    ].filter(Boolean).join(" ");
    if (/(user|用户|you|prompt|human)/i.test(text)) return "user";
    if (/(assistant|agent|model|response)/i.test(text)) return "assistant";
    return "";
  }

  function timelineLabel(node) {
    const preferred = node.querySelector?.("[data-message-author-role='user'],[data-testid*='user'],[data-testid*='prompt']");
    return (preferred?.textContent || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 220);
  }

  function elementTopInScroller(node, scroller) {
    const rect = node.getBoundingClientRect();
    if (!scroller || scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
      return (document.scrollingElement || document.documentElement).scrollTop + rect.top;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    return scroller.scrollTop + rect.top - scrollerRect.top;
  }

  function installTimeline() {
    document.querySelectorAll(".ruizhi-conversation-timeline").forEach((node) => node.remove());
    if (!feature("timeline")) return;
    const questions = timelineQuestions();
    if (questions.length < 2) return;
    const scroller = threadScrollElement();
    const container = document.createElement("div");
    container.className = "ruizhi-conversation-timeline";
    container.dataset.ruizhiTimeline = markers.timeline;
    const track = document.createElement("div");
    track.className = "ruizhi-conversation-timeline-track";
    container.appendChild(track);
    const maxScroll = Math.max(1, scroller.scrollHeight - (scroller.clientHeight || window.innerHeight));
    questions.forEach((node) => {
      const top = Math.max(2, Math.min(98, (elementTopInScroller(node, scroller) / maxScroll) * 100));
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "ruizhi-conversation-timeline-marker";
      marker.style.top = `${top}%`;
      const label = timelineLabel(node).slice(0, 40);
      marker.innerHTML = `<span>${escapeHtml(label)}</span>`;
      marker.addEventListener("click", () => {
        node.scrollIntoView({ block: "center", behavior: "smooth" });
        node.classList.add("ruizhi-timeline-target");
        setTimeout(() => node.classList.remove("ruizhi-timeline-target"), 1200);
      });
      container.appendChild(marker);
    });
    document.body.appendChild(container);
  }

  function scrollKey() {
    const id = location.pathname.split("/").filter(Boolean).pop() || location.href;
    return `ruizhi.threadScroll.${id}`;
  }

  function isScrollableElement(node) {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) return false;
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (!/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`)) return false;
    return node.scrollHeight - node.clientHeight > 24;
  }

  function threadScrollElement() {
    const explicit = document.querySelector("[data-app-action-timeline-scroll]");
    if (isScrollableElement(explicit)) return explicit;
    const threadRoot = document.querySelector("[data-thread-find-target='conversation']");
    for (let node = threadRoot; node instanceof HTMLElement; node = node.parentElement) {
      if (isScrollableElement(node)) return node;
    }
    const candidates = Array.from(document.querySelectorAll("[data-app-action-timeline-scroll],main,[role='main'],[data-thread-find-target='conversation'],.overflow-y-auto,.overflow-auto,[style*='overflow']"))
      .filter(isScrollableElement)
      .sort((left, right) => (right.clientHeight * right.clientWidth) - (left.clientHeight * left.clientWidth));
    return candidates[0] || document.scrollingElement || document.documentElement;
  }

  function readSavedScroll(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return { top: numeric };
    try {
      const parsed = JSON.parse(raw);
      const top = Number(parsed?.top);
      return Number.isFinite(top) ? { top } : null;
    } catch {
      return null;
    }
  }

  function writeSavedScroll(key, scroller) {
    localStorage.setItem(key, JSON.stringify({ top: scroller.scrollTop, at: Date.now(), path: location.href }));
  }

  function installThreadScrollRestore() {
    if (!feature("threadScrollRestore")) return;
    const key = scrollKey();
    const scroller = threadScrollElement();
    const saved = readSavedScroll(key);
    if (state.scrollRestoreKey !== key && saved && Math.abs(scroller.scrollTop) < 8) {
      state.scrollRestoreKey = key;
      setTimeout(() => scroller.scrollTo({ top: saved.top, behavior: "auto" }), 120);
    }
    const eventTarget = (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) ? window : scroller;
    if (!state.scrollBoundElements.has(eventTarget)) {
      state.scrollBoundElements.add(eventTarget);
      on(eventTarget, "scroll", () => {
        if (!feature("threadScrollRestore")) return;
        if (state.scrollSaveTimer) clearTimeout(state.scrollSaveTimer);
        state.scrollSaveTimer = setTimeout(() => writeSavedScroll(scrollKey(), threadScrollElement()), 120);
      }, true);
      on(window, "beforeunload", () => writeSavedScroll(scrollKey(), threadScrollElement()), true);
    }
  }

  function installSettingsVersionFix() {
    const appVersion = state.settings.appDisplayVersion || state.settings.appVersion;
    if (!appVersion) return;
    const displayVersion = appVersion;
    const labelPattern = /(当前版本|应用版本|App Version|Current Version|Current version)/;
    const versionPattern = /\b(?:Codex\s*)?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?\b/;
    const nodes = Array.from(document.querySelectorAll("span,div,p,code"));
    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || node.dataset.ruizhiSettingsVersionFix === markers.settingsVersion) continue;
      const text = (node.textContent || "").trim();
      if (!versionPattern.test(text) || text.includes(appVersion)) continue;
      let scope = node.parentElement;
      let matched = false;
      for (let depth = 0; scope && depth < 6; depth += 1, scope = scope.parentElement) {
        const scopeText = scope.textContent || "";
        if (scopeText.length < 900 && labelPattern.test(scopeText)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      node.textContent = text.replace(versionPattern, displayVersion);
      node.dataset.ruizhiSettingsVersionFix = markers.settingsVersion;
    }
  }

  function controlText(element) {
    return [
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.textContent
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function isFooterHelpControl(element) {
    return /^(Help|帮助)(\s|$)/i.test(controlText(element));
  }

  function isFooterSettingsControl(element) {
    return /^(Settings|设置|Preferences|偏好设置)(\s|$)/i.test(controlText(element));
  }

  function findFooterHelpControl() {
    const controls = Array.from(document.querySelectorAll("button,a,[role='button']"));
    const helpControls = controls.filter((control) => control instanceof HTMLElement && isFooterHelpControl(control));
    for (const help of helpControls) {
      let scope = help.parentElement;
      for (let depth = 0; scope && depth < 6; depth += 1, scope = scope.parentElement) {
        const scopeText = (scope.textContent || "").replace(/\s+/g, " ").trim();
        if (scopeText.length > 700) continue;
        const hasSettings = Array.from(scope.querySelectorAll("button,a,[role='button']"))
          .some((control) => control !== help && control instanceof HTMLElement && isFooterSettingsControl(control));
        if (hasSettings) return help;
      }
    }
    return null;
  }

  function installFooterVersionBadge() {
    const displayVersion = state.settings.appDisplayVersion || state.settings.appVersion;
    if (!displayVersion) return;
    const help = findFooterHelpControl();
    if (!help) return;
    help.style.display = "none";
    help.setAttribute("aria-hidden", "true");
    help.dataset.ruizhiFooterHelpHidden = "true";
    const parent = help.parentElement;
    if (!parent) return;
    let badge = parent.querySelector(":scope > .ruizhi-footer-version-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "ruizhi-footer-version-badge";
      parent.insertBefore(badge, help.nextSibling);
    }
    badge.textContent = `锐捷 ${displayVersion}`;
    badge.dataset.ruizhiFooterVersion = displayVersion;
  }


  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function scheduleScan() {
    if (state.scanTimer || state.disposed) return;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      scan();
    }, 160);
  }

  function scan() {
    if (state.disposed || !state.settings.enabled) return;
    try {
      injectStyle();
      renderMenu();
      enablePluginEntry();
      unblockPluginInstallButtons();
      installSessionActions();
      installThreadSorting();
      installThreadScrollRestore();
      installTimeline();
      installSettingsVersionFix();
      installFooterVersionBadge();
    } catch (error) {
      bridgeCall("/diagnostics/log", { event: "scan_failed", message: String(error?.message || error) });
    }
  }

  async function boot() {
    try {
      const settings = await window.ruizhiDesktop?.enhance?.getSettings?.();
      if (settings) state.settings = normalizeSettings(settings);
    } catch {
    }
    scan();
    state.observer = new MutationObserver(scheduleScan);
    state.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    on(window, "resize", scheduleScan);
    on(window, "popstate", scheduleScan);
    on(window, "hashchange", scheduleScan);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
  return window[runtimeKey];
  }

  const hasCommonJsModule = typeof module !== "undefined" && module.exports;
  globalScope.__RUIZHI_INSTALL_PAGE_ENHANCE__ = installRuizhiPageEnhance;
  if (hasCommonJsModule) {
    module.exports = { installRuizhiPageEnhance };
  }
  if (!hasCommonJsModule && globalScope.window && globalScope.document && !globalScope.__RUIZHI_PAGE_ENHANCE_SKIP_AUTO__) {
    installRuizhiPageEnhance({
      window: globalScope.window,
      document: globalScope.document,
      ruizhiDesktop: globalScope.window.ruizhiDesktop,
      config: globalScope.window.__RUIZHI_PAGE_ENHANCE_CONFIG__
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
