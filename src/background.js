importScripts("storage.js");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleMessage(message, sender) {
  if (!message || !message.type) {
    throw new Error("Missing message type.");
  }

  if (message.type === "GET_SITE_CONFIG") {
    const siteKey = message.siteKey || siteKeyFromUrl(sender.tab.url);
    return {
      siteKey,
      config: await getSiteConfig(siteKey),
      model: await getModelConfig()
    };
  }

  if (message.type === "CAPTCHA_FROM_IMAGE_URL") {
    const model = await getModelConfig();
    const dataUrl = await imageUrlToDataUrl(message.imageUrl, sender.tab && sender.tab.url);
    return recognizeCaptcha(dataUrl, model);
  }

  if (message.type === "RECOGNIZE_CAPTCHA") {
    const model = await getModelConfig();
    return recognizeCaptcha(message.dataUrl, model);
  }

  if (message.type === "SAVE_SITE_CREDENTIALS") {
    const siteKey = message.siteKey || siteKeyFromUrl(sender.tab.url);
    await saveEncryptedSiteCredentials(
      siteKey,
      message.username || "",
      message.password || "",
      message.masterPassword || ""
    );
    return { siteKey };
  }

  if (message.type === "GET_SECURITY_STATUS") {
    return getSecurityStatus();
  }

  if (message.type === "UNLOCK_SECURITY") {
    await unlockSecurity(message.masterPassword || "");
    return getSecurityStatus();
  }

  if (message.type === "MIGRATE_CREDENTIALS") {
    await migratePlaintextCredentials(message.masterPassword || "");
    return getSecurityStatus();
  }

  if (message.type === "REVEAL_SITE_CREDENTIALS") {
    return revealSiteCredentials(message.siteKey, message.masterPassword || "");
  }

  if (message.type === "TEST_MODEL") {
    return recognizeCaptcha(message.dataUrl, message.model);
  }

  throw new Error(`Unknown message type: ${message.type}`);
}

async function imageUrlToDataUrl(imageUrl, pageUrl) {
  if (!imageUrl) {
    throw new Error("验证码图片地址为空。");
  }

  if (imageUrl.startsWith("data:")) {
    return imageUrl;
  }

  const absoluteUrl = new URL(imageUrl, pageUrl).href;
  const response = await fetch(absoluteUrl, {
    credentials: "include",
    cache: "no-store",
    referrer: pageUrl || undefined
  });

  if (!response.ok) {
    throw new Error(`读取验证码图片失败：HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "image/png";
  const buffer = await response.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  return `data:${contentType};base64,${base64}`;
}

async function recognizeCaptcha(dataUrl, model) {
  if (!model || !model.endpoint || !model.apiKey || !model.modelId) {
    throw new Error("请先在插件弹窗里配置模型 URL、API Key 和模型 ID。");
  }
  if (!dataUrl || !dataUrl.startsWith("data:image/")) {
    throw new Error("验证码图片格式不正确。");
  }

  const response = await fetch(resolveChatCompletionsEndpoint(model.endpoint), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${model.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: model.modelId,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "请只识别图片验证码中的文字。只输出验证码本身，不要解释，不要添加标点或空格。"
            },
            {
              type: "image_url",
              image_url: {
                url: dataUrl
              }
            }
          ]
        }
      ],
      temperature: 0,
      max_tokens: 24
    })
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`模型接口调用失败：HTTP ${response.status} ${bodyText.slice(0, 300)}`);
  }

  const body = JSON.parse(bodyText);
  const raw = extractModelText(body);
  const text = normalizeCaptcha(raw);
  if (!text) {
    throw new Error("模型没有返回可用的验证码文本。");
  }
  return { text, raw };
}

function resolveChatCompletionsEndpoint(endpoint) {
  const value = String(endpoint || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(value)) {
    return value;
  }
  return `${value}/chat/completions`;
}

function extractModelText(body) {
  const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => part.text || "").join("");
  }
  if (typeof body.output_text === "string") {
    return body.output_text;
  }
  if (Array.isArray(body.output)) {
    return body.output
      .flatMap((item) => item.content || [])
      .map((part) => part.text || "")
      .join("");
  }
  return "";
}

function normalizeCaptcha(value) {
  return String(value || "")
    .trim()
    .replace(/[`"'“”‘’。。，,;；:：\s]/g, "")
    .slice(0, 12);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}
