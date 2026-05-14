(() => {
  const FIELD_EVENT_OPTIONS = { bubbles: true, cancelable: true };
  const MAX_CAPTCHA_WIDTH = 360;
  const MAX_CAPTCHA_HEIGHT = 180;
  const MIN_CAPTCHA_WIDTH = 30;
  const MIN_CAPTCHA_HEIGHT = 18;
  const CAPTCHA_COOLDOWN_MS = 1200;

  let state = {
    siteKey: `${location.protocol}//${location.host}`,
    config: null,
    lastCaptchaFingerprint: "",
    lastCaptchaAt: 0,
    observer: null,
    runTimer: 0,
    pendingCredentials: null,
    savePromptVisible: false,
    lastUrl: location.href
  };

  boot();

  async function boot() {
    await refreshConfig();
    runAutofill("boot");
    installObservers();
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.type === "RUN_AUTOFILL") {
        refreshConfig()
          .then(() => runAutofill("manual"))
          .then((result) => sendResponse({ ok: true, result }))
          .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
        return true;
      }
      return false;
    });
  }

  async function refreshConfig() {
    const response = await sendRuntimeMessage({
      type: "GET_SITE_CONFIG",
      siteKey: state.siteKey
    });
    state.config = response.config;
  }

  function installObservers() {
    document.addEventListener("input", onUserInput, true);
    document.addEventListener("change", onUserInput, true);
    document.addEventListener("click", onPossibleCaptchaClick, true);
    document.addEventListener("click", onPossibleLoginClick, true);
    document.addEventListener("submit", onPossibleLoginSubmit, true);

    if (state.observer) {
      state.observer.disconnect();
    }
    state.observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => {
        if (mutation.type === "attributes") {
          return ["src", "style", "class"].includes(mutation.attributeName);
        }
        return mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0;
      });
      if (relevant) {
        scheduleRun("mutation");
        scheduleSavePromptCheck("dom-change");
      }
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "style", "class"]
    });

    attachCaptchaLoadListeners();
    startUrlWatcher();
  }

  function scheduleRun(reason) {
    clearTimeout(state.runTimer);
    state.runTimer = window.setTimeout(() => runAutofill(reason), 300);
  }

  async function runAutofill(reason) {
    if (!state.config) {
      return { filledCredentials: false, filledCaptcha: false };
    }

    const result = {
      reason,
      filledCredentials: false,
      filledCaptcha: false
    };

    if (state.config.autoFillCredentials) {
      result.filledCredentials = fillCredentials();
    }

    attachCaptchaLoadListeners();

    if (state.config.autoFillCaptcha) {
      result.filledCaptcha = await fillCaptcha();
    }

    return result;
  }

  function fillCredentials() {
    const username = state.config.username || "";
    const password = state.config.password || "";
    if (!username && !password) {
      return false;
    }

    const passwordInput = findPasswordInput();
    const usernameInput = findUsernameInput(passwordInput);
    let changed = false;

    if (usernameInput && username) {
      changed = setInputValue(usernameInput, username) || changed;
    }
    if (passwordInput && password) {
      changed = setInputValue(passwordInput, password) || changed;
    }

    return changed;
  }

  function captureCredentials() {
    if (hasStoredCredentials()) {
      return false;
    }

    const usernameInput = findUsernameInput(findPasswordInput());
    const passwordInput = findPasswordInput();
    const username = usernameInput ? usernameInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value : "";

    if (!username || !password) {
      return false;
    }

    state.pendingCredentials = {
      username,
      password,
      capturedAt: Date.now(),
      url: location.href
    };
    scheduleSavePromptCheck("login-action");
    return true;
  }

  function onPossibleLoginSubmit() {
    captureCredentials();
  }

  function onPossibleLoginClick(event) {
    const target = event.target;
    if (!target || !(target instanceof Element)) {
      return;
    }
    const button = target.closest("button, input[type='button'], input[type='submit'], [role='button']");
    if (!button || !isLoginButtonLike(button)) {
      return;
    }
    captureCredentials();
  }

  function isLoginButtonLike(element) {
    const text = [
      element.id,
      element.className,
      element.getAttribute("name"),
      element.getAttribute("value"),
      element.getAttribute("aria-label"),
      element.textContent
    ].join(" ");
    return /(login|sign.?in|submit|登录|登入|确定)/i.test(text);
  }

  function startUrlWatcher() {
    window.setInterval(() => {
      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        scheduleSavePromptCheck("url-change");
      }
    }, 800);
  }

  function scheduleSavePromptCheck(reason) {
    window.setTimeout(() => maybeShowSavePrompt(reason), 1200);
    window.setTimeout(() => maybeShowSavePrompt(reason), 3000);
  }

  async function maybeShowSavePrompt(reason) {
    if (!state.pendingCredentials || state.savePromptVisible) {
      return;
    }
    if (hasStoredCredentials()) {
      state.pendingCredentials = null;
      return;
    }
    await refreshConfig().catch(() => {});
    if (hasStoredCredentials()) {
      state.pendingCredentials = null;
      return;
    }
    if (Date.now() - state.pendingCredentials.capturedAt > 30000) {
      state.pendingCredentials = null;
      return;
    }

    const passwordInput = findPasswordInput();
    const likelyLoggedIn = location.href !== state.pendingCredentials.url
      || !passwordInput
      || !isVisible(passwordInput)
      || !/login|signin|auth/i.test(location.href);

    if (!likelyLoggedIn) {
      return;
    }

    showSavePrompt(reason);
  }

  function hasStoredCredentials() {
    return Boolean(state.config && state.config.username && state.config.password);
  }

  function showSavePrompt() {
    state.savePromptVisible = true;

    const host = document.createElement("div");
    host.id = "ip-login-helper-save-prompt";
    host.style.cssText = [
      "position:fixed",
      "top:18px",
      "right:18px",
      "z-index:2147483647",
      "width:320px",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    ].join(";");

    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .card {
          background: #fff;
          border: 1px solid #d0d5dd;
          border-radius: 8px;
          box-shadow: 0 10px 30px rgba(16, 24, 40, .18);
          color: #1f2937;
          padding: 14px;
        }
        .title {
          font-size: 14px;
          font-weight: 650;
          margin: 0 0 6px;
        }
        .body {
          color: #4b5563;
          font-size: 13px;
          line-height: 1.45;
          margin: 0 0 12px;
        }
        .actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }
        button {
          border: 0;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          min-height: 30px;
          padding: 0 12px;
        }
        .cancel {
          background: #eef2f6;
          color: #344054;
        }
        .confirm {
          background: #1a73e8;
          color: #fff;
          font-weight: 600;
        }
      </style>
      <div class="card">
        <p class="title">保存到 Smart Login Helper？</p>
        <p class="body">检测到本次登录已完成，是否把当前站点的用户名和密码保存到本机缓存，方便下次自动填充？</p>
        <div class="actions">
          <button class="cancel" type="button">暂不保存</button>
          <button class="confirm" type="button">确定保存</button>
        </div>
      </div>
    `;

    shadow.querySelector(".cancel").addEventListener("click", () => {
      state.pendingCredentials = null;
      state.savePromptVisible = false;
      host.remove();
    });

    shadow.querySelector(".confirm").addEventListener("click", async () => {
      const credentials = state.pendingCredentials;
      state.pendingCredentials = null;
      state.savePromptVisible = false;
      host.remove();

      if (!credentials) {
        return;
      }

      try {
        await sendRuntimeMessage({
          type: "SAVE_SITE_CREDENTIALS",
          siteKey: state.siteKey,
          username: credentials.username,
          password: credentials.password
        });
        state.config = {
          ...state.config,
          username: credentials.username,
          password: credentials.password,
          autoFillCredentials: true
        };
        showToast("已保存到 Smart Login Helper，下次进入当前站点时会自动填充。", "success");
      } catch (error) {
        showToast(`保存失败：${error.message || error}`, "error");
      }
    });

    document.documentElement.appendChild(host);
  }

  function showToast(message, type) {
    const oldToast = document.getElementById("ip-login-helper-toast");
    if (oldToast) {
      oldToast.remove();
    }

    const toast = document.createElement("div");
    toast.id = "ip-login-helper-toast";
    toast.style.cssText = [
      "position:fixed",
      "top:18px",
      "right:18px",
      "z-index:2147483647",
      "max-width:360px",
      "background:#fff",
      `border:1px solid ${type === "error" ? "#fda29b" : "#abefc6"}`,
      "border-radius:8px",
      "box-shadow:0 10px 30px rgba(16,24,40,.16)",
      `color:${type === "error" ? "#b42318" : "#067647"}`,
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "font-size:13px",
      "font-weight:650",
      "line-height:1.45",
      "padding:12px 14px"
    ].join(";");
    toast.textContent = message;
    document.documentElement.appendChild(toast);
    window.setTimeout(() => toast.remove(), type === "error" ? 5000 : 2200);
  }

  async function fillCaptcha() {
    const captchaInput = findCaptchaInput();
    const captchaImage = findCaptchaImage();
    if (!captchaInput || !captchaImage) {
      return false;
    }

    const fingerprint = getCaptchaFingerprint(captchaImage);
    const now = Date.now();
    if (fingerprint === state.lastCaptchaFingerprint && now - state.lastCaptchaAt < CAPTCHA_COOLDOWN_MS) {
      return false;
    }

    state.lastCaptchaFingerprint = fingerprint;
    state.lastCaptchaAt = now;

    try {
      const dataUrl = await captchaElementToDataUrl(captchaImage);
      const response = await sendRuntimeMessage({
        type: "RECOGNIZE_CAPTCHA",
        dataUrl
      });
      return setInputValue(captchaInput, response.text);
    } catch (canvasError) {
      const imageUrl = getImageUrl(captchaImage);
      if (!imageUrl) {
        console.warn("[IP Login Helper] Captcha image source not found.", canvasError);
        return false;
      }
      try {
        const response = await sendRuntimeMessage({
          type: "CAPTCHA_FROM_IMAGE_URL",
          imageUrl
        });
        return setInputValue(captchaInput, response.text);
      } catch (fetchError) {
        console.warn("[IP Login Helper] Captcha recognition failed.", fetchError);
        return false;
      }
    }
  }

  function findPasswordInput() {
    const selector = state.config.selectors && state.config.selectors.password;
    return queryVisibleInput(selector)
      || queryVisibleInput("#password, input[name='password']")
      || firstVisible(document.querySelectorAll("input[type='password']"));
  }

  function findUsernameInput(passwordInput) {
    const selector = state.config.selectors && state.config.selectors.username;
    const configured = queryVisibleInput(selector);
    if (configured) {
      return configured;
    }

    const known = queryVisibleInput("#username, input[name='username'], input[autocomplete='username']");
    if (known) {
      return known;
    }

    const candidates = visibleInputs().filter((input) => {
      const type = (input.getAttribute("type") || "text").toLowerCase();
      if (!["", "text", "email", "tel", "number", "search"].includes(type)) {
        return false;
      }
      if (isCaptchaInput(input)) {
        return false;
      }
      return scoreUsernameInput(input) > 0;
    });

    if (passwordInput) {
      const beforePassword = candidates.filter((input) => input.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING);
      beforePassword.sort((a, b) => distanceTo(a, passwordInput) - distanceTo(b, passwordInput));
      if (beforePassword[0]) {
        return beforePassword[0];
      }
    }

    candidates.sort((a, b) => scoreUsernameInput(b) - scoreUsernameInput(a));
    return candidates[0] || null;
  }

  function findCaptchaInput() {
    const selector = state.config.selectors && state.config.selectors.captchaInput;
    const configured = queryVisibleInput(selector);
    if (configured) {
      return configured;
    }

    const known = queryVisibleInput("#imgCode, input[name='imgCode']");
    if (known) {
      return known;
    }

    const candidates = visibleInputs().filter(isCaptchaInput);
    candidates.sort((a, b) => scoreCaptchaInput(b) - scoreCaptchaInput(a));
    return candidates[0] || null;
  }

  function findCaptchaImage() {
    const selector = state.config.selectors && state.config.selectors.captchaImage;
    const configured = firstVisible(selector ? document.querySelectorAll(selector) : []);
    if (configured) {
      return configured;
    }

    const known = firstVisible(document.querySelectorAll("#captchaImg, img.verification-img"));
    if (known) {
      return known;
    }

    const candidates = [
      ...document.querySelectorAll("img"),
      ...document.querySelectorAll("[style*='background-image']")
    ].filter(isCaptchaImageLike);

    candidates.sort((a, b) => scoreCaptchaImage(b) - scoreCaptchaImage(a));
    return candidates[0] || null;
  }

  function attachCaptchaLoadListeners() {
    document.querySelectorAll("img").forEach((image) => {
      if (image.__ipLoginHelperLoadBound) {
        return;
      }
      image.__ipLoginHelperLoadBound = true;
      image.addEventListener("load", () => {
        if (isCaptchaImageLike(image)) {
          scheduleRun("captcha-load");
        }
      });
    });
  }

  function onPossibleCaptchaClick(event) {
    const target = event.target;
    if (!target || !(target instanceof Element)) {
      return;
    }
    const captchaImage = target.closest("img, [style*='background-image']");
    if (captchaImage && isCaptchaImageLike(captchaImage)) {
      scheduleRun("captcha-click");
    }
  }

  function onUserInput(event) {
    const target = event.target;
    if (!target || !(target instanceof HTMLInputElement)) {
      return;
    }
    if (target === findCaptchaInput()) {
      state.lastCaptchaFingerprint = "";
    }
  }

  function queryVisibleInput(selector) {
    if (!selector) {
      return null;
    }
    try {
      return firstVisible(document.querySelectorAll(selector));
    } catch (error) {
      console.warn("[IP Login Helper] Invalid selector:", selector, error);
      return null;
    }
  }

  function visibleInputs() {
    return [...document.querySelectorAll("input")]
      .filter((input) => !input.disabled && !input.readOnly && isVisible(input));
  }

  function firstVisible(elements) {
    return [...elements].find((element) => isVisible(element)) || null;
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function setInputValue(input, value) {
    if (!input || input.value === value) {
      return false;
    }

    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }

    input.dispatchEvent(new Event("input", FIELD_EVENT_OPTIONS));
    input.dispatchEvent(new Event("change", FIELD_EVENT_OPTIONS));
    return true;
  }

  function scoreUsernameInput(input) {
    const text = inputSignals(input);
    let score = 0;
    if (/(user|account|login|name|phone|mobile|email|mail|tenant|工号|账号|帐号|用户名|用户|手机|邮箱|登录名)/i.test(text)) {
      score += 5;
    }
    if (/(captcha|code|verify|验证码|校验码)/i.test(text)) {
      score -= 10;
    }
    if ((input.getAttribute("type") || "").toLowerCase() === "password") {
      score -= 10;
    }
    return score;
  }

  function isCaptchaInput(input) {
    return scoreCaptchaInput(input) >= 4;
  }

  function scoreCaptchaInput(input) {
    const text = inputSignals(input);
    let score = 0;
    if (/(sms|message|phone|mobile|短信|手机|动态码)/i.test(text)) {
      score -= 6;
    }
    if (/(captcha|verify|verification|valid|auth.?code|image.?code|code|验证码|校验码|图形码|图片码|安全码)/i.test(text)) {
      score += 5;
    }
    if (/(imgCode|image.?code|图形码|图片码)/i.test(text)) {
      score += 4;
    }
    const maxLength = Number(input.getAttribute("maxlength") || 0);
    if (maxLength >= 4 && maxLength <= 8) {
      score += 2;
    }
    if ((input.getAttribute("type") || "text").toLowerCase() === "password") {
      score -= 10;
    }
    return score;
  }

  function inputSignals(input) {
    const labels = [];
    if (input.id) {
      const label = document.querySelector(`label[for="${cssEscape(input.id)}"]`);
      if (label) {
        labels.push(label.textContent || "");
      }
    }
    const parentText = input.closest(".el-form-item, .ant-form-item, .form-item, .login-item, .input-item, div")?.textContent || "";
    return [
      input.id,
      input.name,
      input.className,
      input.placeholder,
      input.autocomplete,
      input.getAttribute("aria-label"),
      ...labels,
      parentText.slice(0, 120)
    ].join(" ");
  }

  function isCaptchaImageLike(element) {
    if (!isVisible(element)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < MIN_CAPTCHA_WIDTH || rect.height < MIN_CAPTCHA_HEIGHT) {
      return false;
    }
    if (rect.width > MAX_CAPTCHA_WIDTH || rect.height > MAX_CAPTCHA_HEIGHT) {
      return false;
    }
    const text = [
      element.id,
      element.className,
      element.getAttribute("alt"),
      element.getAttribute("title"),
      getImageUrl(element)
    ].join(" ");
    if (/(qr|qrcode|二维码|avatar|logo|icon)/i.test(text)) {
      return false;
    }
    return /(captcha|verify|verification|valid|code|kaptcha|验证码|校验码|图形码|图片码)/i.test(text) || scoreCaptchaImage(element) > 0;
  }

  function scoreCaptchaImage(element) {
    const rect = element.getBoundingClientRect();
    const text = [
      element.id,
      element.className,
      element.getAttribute("alt"),
      element.getAttribute("title"),
      getImageUrl(element)
    ].join(" ");
    let score = 0;
    if (/(captcha|verify|verification|valid|code|kaptcha|验证码|校验码|图形码|图片码)/i.test(text)) {
      score += 8;
    }
    if (rect.width >= 50 && rect.width <= 180 && rect.height >= 24 && rect.height <= 80) {
      score += 3;
    }
    const captchaInput = findCaptchaInput();
    if (captchaInput) {
      score += Math.max(0, 5 - Math.floor(distanceTo(element, captchaInput) / 200));
    }
    return score;
  }

  function distanceTo(a, b) {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return Math.abs(ar.left - br.left) + Math.abs(ar.top - br.top);
  }

  function getCaptchaFingerprint(element) {
    const rect = element.getBoundingClientRect();
    return [
      getImageUrl(element),
      Math.round(rect.width),
      Math.round(rect.height),
      element.getAttribute("style") || "",
      Date.now() - (Date.now() % CAPTCHA_COOLDOWN_MS)
    ].join("|");
  }

  function getImageUrl(element) {
    if (element instanceof HTMLImageElement) {
      return element.currentSrc || element.src || "";
    }
    const background = getComputedStyle(element).backgroundImage;
    const match = /url\(["']?(.*?)["']?\)/.exec(background);
    return match ? match[1] : "";
  }

  async function captchaElementToDataUrl(element) {
    if (!(element instanceof HTMLImageElement)) {
      throw new Error("Only img elements can be converted directly.");
    }
    if (!element.complete || !element.naturalWidth || !element.naturalHeight) {
      await waitForImageLoad(element);
    }

    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(element, 0, 0);
    return canvas.toDataURL("image/png");
  }

  function waitForImageLoad(image) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("验证码图片加载超时。")), 3000);
      image.addEventListener("load", () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
      image.addEventListener("error", () => {
        window.clearTimeout(timer);
        reject(new Error("验证码图片加载失败。"));
      }, { once: true });
    });
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

  function cssEscape(value) {
    if (window.CSS && CSS.escape) {
      return CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }
})();
