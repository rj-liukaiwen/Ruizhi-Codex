import fs from "node:fs";

const LOGIN_SUCCESS_STRINGS = {
  title: "Signed in to Codex",
  legacyMessage: "You may now close this page",
  currentMessage: "You&rsquo;re signed in and may close this tab",
};

function paddedUtf8Replacement(sourceText, replacementText, label) {
  const source = Buffer.from(sourceText, "utf8");
  const replacement = Buffer.from(String(replacementText), "utf8");
  if (replacement.length > source.length) {
    throw new Error(
      `${label} 文案过长：最多 ${source.length} 字节，当前 ${replacement.length} 字节`,
    );
  }

  const padded = Buffer.alloc(source.length, 0x20);
  replacement.copy(padded);
  return { source, replacement: padded };
}

function replaceAllInPlace(buffer, source, replacement) {
  let count = 0;
  let offset = 0;
  while (offset <= buffer.length - source.length) {
    const index = buffer.indexOf(source, offset);
    if (index < 0) break;
    replacement.copy(buffer, index);
    count += 1;
    offset = index + source.length;
  }
  return count;
}

export function patchCodexLoginSuccessBuffer(input, copy) {
  if (!Buffer.isBuffer(input)) {
    throw new TypeError("Codex CLI 输入必须是 Buffer");
  }

  const replacements = {};
  const output = Buffer.from(input);
  for (const [key, sourceText] of Object.entries(LOGIN_SUCCESS_STRINGS)) {
    const replacementText = copy?.[key];
    if (typeof replacementText !== "string" || replacementText.length === 0) {
      throw new Error(`缺少 loginSuccessPage.${key} 文案`);
    }
    const pair = paddedUtf8Replacement(sourceText, replacementText, `loginSuccessPage.${key}`);
    replacements[key] = replaceAllInPlace(output, pair.source, pair.replacement);
  }

  if (replacements.title === 0 || (replacements.legacyMessage === 0 && replacements.currentMessage === 0)) {
    throw new Error("没有找到 Codex OAuth 成功页文案，当前 Codex CLI 版本可能已改变");
  }

  return { buffer: output, replacements };
}

export function patchCodexLoginSuccessBinary(binaryPath, copy) {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`没有找到 Codex CLI：${binaryPath}`);
  }

  const original = fs.readFileSync(binaryPath);
  const result = patchCodexLoginSuccessBuffer(original, copy);
  if (result.buffer.length !== original.length) {
    throw new Error("Codex OAuth 成功页补丁改变了二进制长度");
  }
  fs.writeFileSync(binaryPath, result.buffer);
  return result;
}
