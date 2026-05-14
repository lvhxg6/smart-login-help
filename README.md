# Smart Login Helper

简称：SL Helper

一个 Chrome / Edge / Chromium Manifest V3 插件，用于在授权的内部系统中本地保存账号密码，并在登录页自动代填账号、密码和图片文字验证码。

## 功能

- 按 `protocol + hostname + port` 保存站点配置，例如 `https://192.168.170.20`。
- 凭据只存储在 `chrome.storage.local`，不做云同步。
- 首次手动登录成功后，页面右上角询问是否保存到 Smart Login Helper。
- 弹窗展示已管理站点列表，可删除单个站点缓存。
- 自动识别常见用户名、密码、验证码输入框。
- 支持在弹窗中为统一前端框架填写精确 CSS 选择器。
- 监听验证码图片 `load`、`src` 变化、DOM 替换和点击刷新，自动重新识别。
- 验证码识别调用 OpenAI-compatible `chat/completions` 风格接口。
- 不自动点击登录按钮，保留人工确认。
- 首次手动登录成功后，在页面右上角询问是否保存用户名和密码到本机缓存。

## 加载方式

1. 打开 Chrome / Edge 扩展管理页面。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录：`ip-login-helper`。
5. 打开登录页后点击插件图标，配置模型。
6. 首次手动登录成功后，在页面右上角确认是否保存账号密码。

## 首次保存流程

如果当前站点还没有保存用户名和密码：

1. 插件会先尝试识别并填写图片文字验证码。
2. 你手动输入用户名和密码。
3. 你点击页面上的登录按钮。
4. 插件检测到登录成功后，会在右上角提示是否保存到 Smart Login Helper。
5. 点击“确定保存”后，下次进入当前站点会自动填充用户名和密码。

## 模型接口要求

弹窗中的 `URL` 建议填写完整的聊天补全接口地址，例如：

```text
https://your-model-host/v1
```

插件会自动拼接 `/chat/completions`。如果你填完整的 `/v1/chat/completions` 也可以。

请求体格式为：

```json
{
  "model": "你的模型 ID",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "请只识别图片验证码中的文字。只输出验证码本身，不要解释，不要添加标点或空格。"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,..."
          }
        }
      ]
    }
  ],
  "temperature": 0,
  "max_tokens": 24
}
```

返回会优先读取 `choices[0].message.content`，同时兼容部分 `output_text` / `output` 风格返回。

## 选择器覆盖

如果自动识别不稳定，可以在插件弹窗的“选择器覆盖”里配置：

- 用户名输入框：例如 `input[name='username']`
- 密码输入框：例如 `input[type='password']`
- 验证码输入框：例如 `input[name='code']`
- 验证码图片：例如 `img.captcha`

## 测试目标

用户提供的内网测试地址：

```text
https://192.168.170.20/#/login
```

如当前机器能访问该地址，可打开后检查 DOM，再补充精确选择器。
