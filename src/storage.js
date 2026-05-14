const STORAGE_KEYS = {
  sites: "sites",
  model: "model",
  defaults: "defaults",
  security: "security",
  sessionKey: "sessionKey"
};

const SECURITY_VERIFIER = "SL_HELPER_VERIFIER_V1";
const PBKDF2_ITERATIONS = 250000;

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

async function sessionGet(key) {
  if (!chrome.storage.session) {
    return {};
  }
  return chrome.storage.session.get(key);
}

async function sessionSet(value) {
  if (!chrome.storage.session) {
    return;
  }
  await chrome.storage.session.set(value);
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
  const config = {
    ...defaults,
    ...site,
    selectors: {
      ...defaults.selectors,
      ...(site.selectors || {})
    }
  };

  if (site.credentials && site.credentials.encrypted) {
    config.hasCredentials = true;
    config.credentialsEncrypted = true;
    try {
      const credentials = await decryptStoredCredentials(site.credentials);
      config.username = credentials.username || "";
      config.password = credentials.password || "";
      config.credentialsLocked = false;
    } catch (error) {
      config.username = "";
      config.password = "";
      config.credentialsLocked = true;
    }
  } else {
    config.hasCredentials = Boolean(site.username && site.password);
    config.credentialsEncrypted = false;
    config.credentialsLocked = false;
  }

  return config;
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

async function getSecurityStatus() {
  const result = await storageGet(STORAGE_KEYS.security);
  const session = await sessionGet(STORAGE_KEYS.sessionKey);
  return {
    enabled: Boolean(result[STORAGE_KEYS.security]),
    unlocked: Boolean(session[STORAGE_KEYS.sessionKey])
  };
}

async function unlockSecurity(masterPassword) {
  const security = await getSecurityConfig();
  if (!security) {
    return false;
  }
  const rawKey = await deriveRawKey(masterPassword, security.salt);
  const key = await importAesKey(rawKey);
  const verifier = await decryptWithKey(key, security.verifier);
  if (verifier !== SECURITY_VERIFIER) {
    throw new Error("主密码不正确。");
  }
  await sessionSet({ [STORAGE_KEYS.sessionKey]: rawKey });
  return true;
}

async function saveEncryptedSiteCredentials(siteKey, username, password, masterPassword) {
  const rawKey = await getOrCreateSessionKey(masterPassword);
  const key = await importAesKey(rawKey);
  const credentials = await encryptWithKey(key, JSON.stringify({ username, password }));
  const result = await storageGet(STORAGE_KEYS.sites);
  const sites = result[STORAGE_KEYS.sites] || {};
  const previous = sites[siteKey] || {};

  sites[siteKey] = {
    ...previous,
    username: undefined,
    password: undefined,
    credentials: {
      encrypted: true,
      ...credentials
    },
    autoFillCredentials: true
  };
  delete sites[siteKey].username;
  delete sites[siteKey].password;
  await storageSet({ [STORAGE_KEYS.sites]: sites });
}

async function migratePlaintextCredentials(masterPassword) {
  const rawKey = await getOrCreateSessionKey(masterPassword);
  const key = await importAesKey(rawKey);
  const result = await storageGet(STORAGE_KEYS.sites);
  const sites = result[STORAGE_KEYS.sites] || {};

  for (const siteKey of Object.keys(sites)) {
    const site = sites[siteKey] || {};
    if (site.credentials && site.credentials.encrypted) {
      continue;
    }
    if (!site.username || !site.password) {
      continue;
    }
    const credentials = await encryptWithKey(
      key,
      JSON.stringify({ username: site.username, password: site.password })
    );
    sites[siteKey] = {
      ...site,
      credentials: {
        encrypted: true,
        ...credentials
      }
    };
    delete sites[siteKey].username;
    delete sites[siteKey].password;
  }

  await storageSet({ [STORAGE_KEYS.sites]: sites });
}

async function getOrCreateSessionKey(masterPassword) {
  const session = await sessionGet(STORAGE_KEYS.sessionKey);
  if (session[STORAGE_KEYS.sessionKey]) {
    return session[STORAGE_KEYS.sessionKey];
  }

  if (!masterPassword) {
    throw new Error("需要输入主密码后才能加密保存。");
  }

  let security = await getSecurityConfig();
  if (!security) {
    const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
    const rawKey = await deriveRawKey(masterPassword, salt);
    const key = await importAesKey(rawKey);
    const verifier = await encryptWithKey(key, SECURITY_VERIFIER);
    security = {
      version: 1,
      kdf: "PBKDF2-SHA256",
      iterations: PBKDF2_ITERATIONS,
      salt,
      verifier
    };
    await storageSet({ [STORAGE_KEYS.security]: security });
    await sessionSet({ [STORAGE_KEYS.sessionKey]: rawKey });
    return rawKey;
  }

  await unlockSecurity(masterPassword);
  const unlocked = await sessionGet(STORAGE_KEYS.sessionKey);
  return unlocked[STORAGE_KEYS.sessionKey];
}

async function getSecurityConfig() {
  const result = await storageGet(STORAGE_KEYS.security);
  return result[STORAGE_KEYS.security] || null;
}

async function decryptStoredCredentials(credentials) {
  const session = await sessionGet(STORAGE_KEYS.sessionKey);
  const rawKey = session[STORAGE_KEYS.sessionKey];
  if (!rawKey) {
    throw new Error("凭据已加密，当前未解锁。");
  }
  const key = await importAesKey(rawKey);
  const text = await decryptWithKey(key, credentials);
  return JSON.parse(text);
}

async function deriveRawKey(masterPassword, salt) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64ToBytes(salt),
      iterations: PBKDF2_ITERATIONS
    },
    baseKey,
    256
  );
  return bytesToBase64(new Uint8Array(bits));
}

async function importAesKey(rawKey) {
  return crypto.subtle.importKey(
    "raw",
    base64ToBytes(rawKey),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptWithKey(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(text)
  );
  return {
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted))
  };
}

async function decryptWithKey(key, payload) {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.data)
  );
  return new TextDecoder().decode(decrypted);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
