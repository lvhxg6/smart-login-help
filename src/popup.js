const elements = {
  siteKey: document.getElementById("siteKey"),
  currentState: document.getElementById("currentState"),
  credentialState: document.getElementById("credentialState"),
  captchaState: document.getElementById("captchaState"),
  securityPanel: document.getElementById("securityPanel"),
  securityState: document.getElementById("securityState"),
  masterPassword: document.getElementById("masterPassword"),
  unlockSecurity: document.getElementById("unlockSecurity"),
  siteCount: document.getElementById("siteCount"),
  endpoint: document.getElementById("endpoint"),
  apiKey: document.getElementById("apiKey"),
  modelId: document.getElementById("modelId"),
  provider: document.getElementById("provider"),
  selectorUsername: document.getElementById("selectorUsername"),
  selectorPassword: document.getElementById("selectorPassword"),
  selectorCaptchaInput: document.getElementById("selectorCaptchaInput"),
  selectorCaptchaImage: document.getElementById("selectorCaptchaImage"),
  saveModel: document.getElementById("saveModel"),
  saveSelectors: document.getElementById("saveSelectors"),
  siteList: document.getElementById("siteList"),
  status: document.getElementById("status")
};

let currentSiteKey = "";
let securityStatus = { enabled: false, unlocked: false };
let currentTab = null;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  currentSiteKey = siteKeyFromUrl(tab.url);
  elements.siteKey.textContent = currentSiteKey;

  await loadCurrentSite();
  await loadSecurityStatus();
  await loadModel();
  await renderSiteList();
}

elements.saveModel.addEventListener("click", async () => {
  await saveModelConfig({
    endpoint: elements.endpoint.value.trim(),
    apiKey: elements.apiKey.value.trim(),
    modelId: elements.modelId.value.trim(),
    provider: elements.provider.value
  });
  setStatus("模型配置已保存。");
  await loadCurrentSite();
});

elements.unlockSecurity.addEventListener("click", async () => {
  try {
    const type = securityStatus.enabled ? "UNLOCK_SECURITY" : "MIGRATE_CREDENTIALS";
    await sendRuntimeMessage({
      type,
      masterPassword: elements.masterPassword.value
    });
    elements.masterPassword.value = "";
    setStatus(securityStatus.enabled ? "加密缓存已解锁。" : "已启用加密并迁移现有缓存。");
    await loadSecurityStatus();
    await loadCurrentSite();
    await renderSiteList();
    chrome.tabs.sendMessage(currentTab.id, { type: "RUN_AUTOFILL" }).catch(() => {});
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

elements.saveSelectors.addEventListener("click", async () => {
  await saveSiteConfig(currentSiteKey, {
    selectors: {
      username: elements.selectorUsername.value.trim(),
      password: elements.selectorPassword.value.trim(),
      captchaInput: elements.selectorCaptchaInput.value.trim(),
      captchaImage: elements.selectorCaptchaImage.value.trim()
    }
  });
  setStatus("当前站点选择器已保存。");
});

async function loadCurrentSite() {
  const siteConfig = await getSiteConfig(currentSiteKey);
  const model = await getModelConfig();
  const hasCredentials = Boolean(siteConfig.hasCredentials || (siteConfig.username && siteConfig.password));
  const hasModel = Boolean(model.endpoint && model.apiKey && model.modelId);

  elements.currentState.textContent = siteConfig.credentialsLocked
    ? "账号已加密保存。输入主密码解锁后可自动填充。"
    : hasCredentials
    ? `已保存账号：${siteConfig.username}`
    : "未保存账号。首次登录成功后会询问是否保存。";
  elements.credentialState.textContent = siteConfig.credentialsLocked ? "账号 已加密" : hasCredentials ? "账号 已缓存" : "账号 未缓存";
  elements.captchaState.textContent = hasModel ? "验证码 已配置" : "验证码 未配置";

  elements.selectorUsername.value = siteConfig.selectors.username || "";
  elements.selectorPassword.value = siteConfig.selectors.password || "";
  elements.selectorCaptchaInput.value = siteConfig.selectors.captchaInput || "";
  elements.selectorCaptchaImage.value = siteConfig.selectors.captchaImage || "";
}

async function loadSecurityStatus() {
  const status = await sendRuntimeMessage({ type: "GET_SECURITY_STATUS" });
  securityStatus = status;
  elements.securityState.textContent = status.enabled
    ? status.unlocked ? "已解锁" : "已加密"
    : "未启用";
  elements.unlockSecurity.textContent = status.enabled ? "解锁" : "启用加密";
  elements.securityPanel.open = status.enabled && !status.unlocked;
}

async function loadModel() {
  const model = await getModelConfig();
  elements.endpoint.value = model.endpoint || "";
  elements.apiKey.value = model.apiKey || "";
  elements.modelId.value = model.modelId || "";
  elements.provider.value = model.provider || "openai-compatible";
}

async function renderSiteList() {
  const sites = await getAllSites();
  const entries = Object.entries(sites).sort(([a], [b]) => a.localeCompare(b));

  elements.siteCount.textContent = String(entries.length);
  elements.siteList.textContent = "";

  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有保存任何站点。";
    elements.siteList.appendChild(empty);
    return;
  }

  for (const [siteKey, site] of entries) {
    const item = document.createElement("article");
    item.className = "site-item";

    const host = document.createElement("div");
    host.className = "site-host";
    host.textContent = siteKey;

    const user = document.createElement("div");
    user.className = "site-user";
    user.textContent = site.credentials && site.credentials.encrypted
      ? "账号：已加密"
      : site.username ? `账号：${site.username}` : "账号：未设置";

    const flags = document.createElement("div");
    flags.className = "site-flags";
    flags.append(
      flag(site.autoFillCredentials !== false, "自动填充"),
      flag(site.autoFillCaptcha !== false, "验证码")
    );

    const actions = document.createElement("div");
    actions.className = "site-actions";

    const use = document.createElement("button");
    use.className = "ghost";
    use.type = "button";
    use.textContent = siteKey === currentSiteKey ? "当前站点" : "查看";
    use.disabled = siteKey === currentSiteKey;

    const remove = document.createElement("button");
    remove.className = "danger";
    remove.type = "button";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      await deleteSiteConfig(siteKey);
      await loadCurrentSite();
      await renderSiteList();
      setStatus("已删除站点缓存。");
    });

    actions.append(use, remove);
    item.append(host, user, flags, actions);
    elements.siteList.appendChild(item);
  }
}

function flag(enabled, text) {
  const span = document.createElement("span");
  span.textContent = `${text} ${enabled ? "✓" : "-"}`;
  return span;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error((response && response.error) || "插件后台没有返回结果。"));
        return;
      }
      resolve(response.result);
    });
  });
}

function setStatus(text, isError = false) {
  elements.status.textContent = text;
  elements.status.className = isError ? "error" : "";
  window.setTimeout(() => {
    if (elements.status.textContent === text) {
      elements.status.textContent = "";
      elements.status.className = "";
    }
  }, 3000);
}
