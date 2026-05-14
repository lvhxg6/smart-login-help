const STORAGE_KEYS = {
  sites: "sites",
  model: "model",
  defaults: "defaults"
};

const DEFAULTS = {
  autoFillCredentials: true,
  autoFillCaptcha: true,
  autoSubmitLogin: false,
  selectors: {
    username: "",
    password: "",
    captchaInput: "",
    captchaImage: "",
    loginButton: ""
  }
};

function siteKeyFromUrl(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

async function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

async function storageSet(value) {
  return chrome.storage.local.set(value);
}

async function getDefaults() {
  const result = await storageGet(STORAGE_KEYS.defaults);
  return {
    ...DEFAULTS,
    ...(result[STORAGE_KEYS.defaults] || {}),
    selectors: {
      ...DEFAULTS.selectors,
      ...((result[STORAGE_KEYS.defaults] || {}).selectors || {})
    }
  };
}

async function getModelConfig() {
  const result = await storageGet(STORAGE_KEYS.model);
  return result[STORAGE_KEYS.model] || {
    endpoint: "",
    apiKey: "",
    modelId: "",
    provider: "openai-compatible"
  };
}

async function getAllSites() {
  const result = await storageGet(STORAGE_KEYS.sites);
  return result[STORAGE_KEYS.sites] || {};
}

async function deleteSiteConfig(siteKey) {
  const result = await storageGet(STORAGE_KEYS.sites);
  const sites = result[STORAGE_KEYS.sites] || {};
  delete sites[siteKey];
  await storageSet({ [STORAGE_KEYS.sites]: sites });
}

async function getSiteConfig(siteKey) {
  const result = await storageGet([STORAGE_KEYS.sites, STORAGE_KEYS.defaults]);
  const sites = result[STORAGE_KEYS.sites] || {};
  const defaults = {
    ...DEFAULTS,
    ...(result[STORAGE_KEYS.defaults] || {}),
    selectors: {
      ...DEFAULTS.selectors,
      ...((result[STORAGE_KEYS.defaults] || {}).selectors || {})
    }
  };
  const site = sites[siteKey] || {};
  return {
    ...defaults,
    ...site,
    selectors: {
      ...defaults.selectors,
      ...(site.selectors || {})
    }
  };
}

async function saveSiteConfig(siteKey, config) {
  const result = await storageGet(STORAGE_KEYS.sites);
  const sites = result[STORAGE_KEYS.sites] || {};
  sites[siteKey] = {
    ...(sites[siteKey] || {}),
    ...config,
    selectors: {
      ...((sites[siteKey] || {}).selectors || {}),
      ...(config.selectors || {})
    }
  };
  await storageSet({ [STORAGE_KEYS.sites]: sites });
}

async function saveModelConfig(config) {
  await storageSet({ [STORAGE_KEYS.model]: config });
}
