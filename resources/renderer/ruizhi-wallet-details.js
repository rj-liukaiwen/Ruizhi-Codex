(function ruizhiWalletDetailsModule(globalScope) {
  const rootId = "ruizhi-wallet-details";
  const styleId = "ruizhi-wallet-details-style";
  const marker = "RUIZHI_WALLET_DETAILS_V1";

  function installRuizhiWalletDetails(env = {}) {
    const window = env.window || globalScope.window;
    const document = env.document || window?.document || globalScope.document;
    if (!window || !document) return null;

    let disposed = false;
    let observer = null;
    let scanTimer = null;
    let lastAttemptAt = 0;
    const cleanup = [];

    function addCleanup(fn) {
      cleanup.push(fn);
    }

    function currentRouteText() {
      const location = window.location;
      return `${location?.pathname || ""}${location?.search || ""}${location?.hash || ""}`;
    }

    function isUsageSettingsPage() {
      return currentRouteText().includes("/settings/usage") || Boolean(findWalletCard()) || Boolean(findUsageSettingsContainer({ requireSettings: true, allowFallback: false }));
    }

    function findSettingsSurface() {
      const route = currentRouteText();
      if (route.includes("/settings")) return document.querySelector("main,[role='main']") || document.body;
      const settingsPattern = /(?:\u8bbe\u7f6e|Settings|\u4f7f\u7528\u60c5\u51b5\u548c\u8ba1\u8d39|\u4f7f\u7528\u60c5\u51b5|Usage and billing|Usage)/;
      const dialog = Array.from(document.querySelectorAll("[role='dialog'],[data-testid*='settings'],section,main"))
        .find((node) => node instanceof window.HTMLElement && settingsPattern.test((node.textContent || "").slice(0, 2000)));
      return dialog instanceof window.HTMLElement ? dialog : null;
    }

    function findWalletCard() {
      const label = Array.from(document.querySelectorAll("div,span,h1,h2,h3"))
        .find((node) => /^(\u8d26\u6237\u989d\u5ea6|\u8d26\u6237\u4f59\u989d|Account balance|Account quota)$/.test((node.textContent || "").trim()));
      if (!(label instanceof window.HTMLElement)) return null;
      let row = label;
      for (let depth = 0; row && depth < 7; depth += 1, row = row.parentElement) {
        if (row.querySelector?.("progress[aria-label='\u5269\u4f59\u7528\u91cf'],progress[aria-label='Usage']")) return row.parentElement;
      }
      return null;
    }

    function findUsageSettingsContainer(options = {}) {
      const requireSettings = options.requireSettings !== false;
      const allowFallback = options.allowFallback !== false;
      const settingsSurface = findSettingsSurface();
      if (requireSettings && !settingsSurface) return null;
      const searchRoot = settingsSurface || document;
      const title = Array.from(searchRoot.querySelectorAll("h1,h2,h3,div,span"))
        .find((node) => /^(\u4f7f\u7528\u60c5\u51b5\u548c\u8ba1\u8d39|Usage and billing)$/.test((node.textContent || "").trim()));
      if (title instanceof window.HTMLElement) {
        let section = title;
        for (let depth = 0; section && depth < 5; depth += 1, section = section.parentElement) {
          if (section.matches?.("main,section,[role='main'],[role='dialog']")) return section;
        }
      }
      return allowFallback && currentRouteText().includes("/settings/usage") ? settingsSurface : null;
    }

    function findInsertionTarget() {
      const settingsSurface = findSettingsSurface();
      if (!settingsSurface && !currentRouteText().includes("/settings/usage")) return null;
      const walletCard = findWalletCard();
      if (walletCard?.parentElement && settingsSurface?.contains?.(walletCard)) return { container: walletCard.parentElement, before: walletCard };
      if (!isUsageSettingsPage()) return null;
      const usageContainer = findUsageSettingsContainer({ requireSettings: true, allowFallback: true });
      if (usageContainer) return { container: usageContainer, before: usageContainer.firstElementChild || null };
      return null;
    }

    function removeDetails() {
      document.getElementById(rootId)?.remove();
    }

    function injectStyle() {
      if (document.getElementById(styleId)) return;
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        #${rootId}{display:grid;gap:12px;margin-bottom:24px;color:var(--color-token-text-primary,var(--token-text-primary,#f3f4f6));font-family:system-ui,sans-serif}
        #${rootId} .ruizhi-wallet-heading{display:grid;gap:4px}
        #${rootId} .ruizhi-wallet-title{font-size:14px;font-weight:600}
        #${rootId} .ruizhi-wallet-subtitle{font-size:13px;color:var(--color-token-text-secondary,var(--token-text-secondary,#9ca3af))}
        #${rootId} .ruizhi-wallet-card{display:grid;gap:18px;padding:18px 20px;border:1px solid var(--color-token-border,var(--token-border,#3f3f46));border-radius:16px;background:var(--color-background-panel,var(--color-token-bg-fog,#242424))}
        #${rootId} .ruizhi-wallet-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
        #${rootId} .ruizhi-wallet-metric{display:grid;gap:5px;min-width:0}
        #${rootId} .ruizhi-wallet-label{font-size:12px;color:var(--color-token-text-secondary,var(--token-text-secondary,#9ca3af))}
        #${rootId} .ruizhi-wallet-value{font-size:20px;font-weight:650;line-height:1.2;letter-spacing:-.01em;white-space:nowrap;font-variant-numeric:tabular-nums}
        #${rootId} .ruizhi-wallet-progress{display:grid;gap:8px}
        #${rootId} progress{width:100%;height:7px;overflow:hidden;border:0;border-radius:999px;background:rgba(127,127,127,.2)}
        #${rootId} progress::-webkit-progress-bar{background:rgba(127,127,127,.2);border-radius:999px}
        #${rootId} progress::-webkit-progress-value{background:var(--color-token-text-link-foreground,var(--token-text-link-foreground,#60a5fa));border-radius:999px}
        #${rootId} .ruizhi-wallet-progress-labels{display:flex;justify-content:space-between;gap:16px;font-size:12px;color:var(--color-token-text-secondary,var(--token-text-secondary,#9ca3af));font-variant-numeric:tabular-nums}
        #${rootId} .ruizhi-wallet-error{display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:13px}
        #${rootId} button{border:1px solid var(--color-token-border,var(--token-border,#52525b));border-radius:8px;background:transparent;color:inherit;padding:6px 12px;cursor:pointer}
        @media(max-width:760px){#${rootId} .ruizhi-wallet-metrics{grid-template-columns:1fr}#${rootId} .ruizhi-wallet-value{font-size:18px}}
      `;
      document.head.appendChild(style);
    }

    function createRoot(target) {
      const root = document.createElement("section");
      root.id = rootId;
      root.dataset.ruizhiMarker = marker;
      root.setAttribute("aria-label", "锐捷账户额度明细");
      target.container.insertBefore(root, target.before || null);
      return root;
    }

    function finiteAmount(value, name) {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0) throw new Error(`${name}无效`);
      return amount;
    }

    function formatAmount(value) {
      return new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: "USD",
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }).format(value);
    }

    function formatPercent(value) {
      return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
    }

    function renderMetric(document, label, value) {
      const metric = document.createElement("div");
      metric.className = "ruizhi-wallet-metric";
      const labelNode = document.createElement("span");
      labelNode.className = "ruizhi-wallet-label";
      labelNode.textContent = label;
      const valueNode = document.createElement("strong");
      valueNode.className = "ruizhi-wallet-value";
      valueNode.textContent = formatAmount(value);
      metric.append(labelNode, valueNode);
      return metric;
    }

    function renderDetails(root, metadata) {
      const limit = finiteAmount(metadata.limit_usd, "总额度");
      const used = finiteAmount(metadata.used_usd, "已使用额度");
      const remaining = finiteAmount(metadata.remaining_usd, "剩余额度");
      const usedPercent = limit === 0 ? 0 : Math.max(0, Math.min(100, (used / limit) * 100));
      root.replaceChildren();

      const heading = document.createElement("div");
      heading.className = "ruizhi-wallet-heading";
      const title = document.createElement("div");
      title.className = "ruizhi-wallet-title";
      title.textContent = "账户额度明细";
      const subtitle = document.createElement("div");
      subtitle.className = "ruizhi-wallet-subtitle";
      subtitle.textContent = "数据来自锐鉴 API 模型平台，按当前账户累计。";
      heading.append(title, subtitle);

      const card = document.createElement("div");
      card.className = "ruizhi-wallet-card";
      const metrics = document.createElement("div");
      metrics.className = "ruizhi-wallet-metrics";
      metrics.append(
        renderMetric(document, "总额度", limit),
        renderMetric(document, "已使用", used),
        renderMetric(document, "剩余余额", remaining),
      );
      const progressWrap = document.createElement("div");
      progressWrap.className = "ruizhi-wallet-progress";
      const progress = document.createElement("progress");
      progress.max = 100;
      progress.value = usedPercent;
      progress.setAttribute("aria-label", "账户额度使用比例");
      const progressLabels = document.createElement("div");
      progressLabels.className = "ruizhi-wallet-progress-labels";
      const usedLabel = document.createElement("span");
      usedLabel.textContent = `使用比例 ${formatPercent(usedPercent)}%`;
      const remainingLabel = document.createElement("span");
      remainingLabel.textContent = `剩余 ${formatPercent(100 - usedPercent)}%`;
      progressLabels.append(usedLabel, remainingLabel);
      progressWrap.append(progress, progressLabels);
      card.append(metrics, progressWrap);
      root.append(heading, card);
      root.dataset.status = "ready";
      hideNativeLoadError();
    }

    function hideNativeLoadError() {
      for (const node of document.querySelectorAll("div,span")) {
        const text = (node.textContent || "").trim();
        if (!/^(\u65e0\u6cd5\u52a0\u8f7d\u4f7f\u7528\u8bbe\u7f6e\u3002?|Couldn.?t load usage settings\.?)$/.test(text)) continue;
        let row = node;
        for (let depth = 0; row && depth < 5; depth += 1, row = row.parentElement) {
          if (row instanceof window.HTMLElement && row.textContent?.includes(text)) {
            row.style.display = "none";
            row.setAttribute("aria-hidden", "true");
          }
        }
      }
    }

    function renderError(root, error) {
      if (root.dataset.status === "ready") {
        hideNativeLoadError();
        return;
      }
      root.replaceChildren();
      const line = document.createElement("div");
      line.className = "ruizhi-wallet-error";
      const message = document.createElement("span");
      message.textContent = `额度明细加载失败：${String(error?.message || error)}`;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重试";
      retry.addEventListener("click", () => {
        root.dataset.status = "";
        scheduleScan();
      }, { once: true });
      line.append(message, retry);
      root.append(line);
      root.dataset.status = "error";
      hideNativeLoadError();
    }

    async function scan() {
      if (disposed) return;
      const target = findInsertionTarget();
      if (!target) {
        removeDetails();
        return;
      }
      injectStyle();
      const root = document.getElementById(rootId) || createRoot(target);
      if (root.dataset.status === "loading" || root.dataset.status === "ready") return;
      if (root.dataset.status === "error" && Date.now() - lastAttemptAt < 5000) return;
      lastAttemptAt = Date.now();
      const previousStatus = root.dataset.status;
      if (previousStatus !== "ready") {
        root.dataset.status = "loading";
        root.textContent = "正在加载账户额度明细…";
      }
      try {
        const bridge = env.ruizhiDesktop?.enhance || window.ruizhiDesktop?.enhance || globalScope.ruizhiDesktop?.enhance;
        if (!bridge || typeof bridge.call !== "function") {
          if (previousStatus !== "ready") removeDetails();
          return;
        }
        const result = await bridge.call("/usage/platform", {});
        if (result?.status !== "ok" || !result.metadata) throw new Error(result?.message || "额度数据无效");
        if (!disposed && root.isConnected) renderDetails(root, result.metadata);
      } catch (error) {
        if (!disposed && root.isConnected) {
          root.dataset.status = previousStatus;
          renderError(root, error);
        }
      }
    }

    function scheduleScan() {
      if (disposed || scanTimer) return;
      scanTimer = window.setTimeout(() => {
        scanTimer = null;
        void scan();
      }, 120);
    }

    function dispose() {
      disposed = true;
      if (scanTimer) window.clearTimeout(scanTimer);
      while (cleanup.length) {
        try { cleanup.pop()?.(); } catch {}
      }
      observer?.disconnect();
      removeDetails();
      document.getElementById(styleId)?.remove();
    }

    observer = new window.MutationObserver(scheduleScan);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    const rescanEvents = ["focus", "hashchange", "popstate", "online"];
    for (const eventName of rescanEvents) {
      window.addEventListener(eventName, scheduleScan);
      addCleanup(() => window.removeEventListener(eventName, scheduleScan));
    }
    document.addEventListener("visibilitychange", scheduleScan);
    addCleanup(() => document.removeEventListener("visibilitychange", scheduleScan));
    scheduleScan();
    return { dispose, scan: scheduleScan };
  }

  globalScope.__RUIZHI_INSTALL_WALLET_DETAILS__ = installRuizhiWalletDetails;
})(typeof globalThis !== "undefined" ? globalThis : this);
