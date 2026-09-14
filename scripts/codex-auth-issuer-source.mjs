import fs from "node:fs";
import path from "node:path";

function normalizeIssuer(value) {
  const issuer = String(value ?? "").trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new Error(`Codex OAuth issuer 无效：${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Codex OAuth issuer 只支持 HTTP/HTTPS：${issuer}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error(`Codex OAuth issuer 必须是纯 origin，不能包含账号、路径、查询或锚点：${issuer}`);
  }
  return parsed.origin;
}
function replaceRustStringConstant(source, name, value, label) {
  const pattern = new RegExp(`((?:pub\\(super\\)\\s+)?const\\s+${name}\\s*:\\s*&str\\s*=\\s*)"[^"]*";`);
  if (!pattern.test(source)) {
    throw new Error(`补丁点不存在：${label}`);
  }
  return source.replace(pattern, `$1${JSON.stringify(value)};`);
}

function patchFile(filePath, patcher) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Codex 源码文件不存在：${filePath}`);
  }
  const source = fs.readFileSync(filePath, "utf8");
  const patched = patcher(source);
  if (patched !== source) {
    fs.writeFileSync(filePath, patched, "utf8");
  }
  return patched !== source;
}

export function patchCodexAuthIssuerSource(codexSourceRoot, issuerValue) {
  const issuer = normalizeIssuer(issuerValue);
  const serverPath = path.join(codexSourceRoot, "codex-rs", "login", "src", "server.rs");
  const managerPath = path.join(codexSourceRoot, "codex-rs", "login", "src", "auth", "manager.rs");

  const serverChanged = patchFile(serverPath, (source) =>
    replaceRustStringConstant(source, "DEFAULT_ISSUER", issuer, "Codex OAuth authorize issuer"),
  );
  const managerChanged = patchFile(managerPath, (source) => {
    let next = replaceRustStringConstant(
      source,
      "REFRESH_TOKEN_URL",
      `${issuer}/oauth/token`,
      "Codex OAuth refresh token URL",
    );
    next = replaceRustStringConstant(
      next,
      "REVOKE_TOKEN_URL",
      `${issuer}/oauth/revoke`,
      "Codex OAuth revoke token URL",
    );
    return next;
  });

  return {
    issuer,
    changed: serverChanged || managerChanged,
    files: [serverPath, managerPath],
  };
}
