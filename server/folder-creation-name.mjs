// A single new directory component, not a path normalizer. Platform comes
// from the server, never from the HTTP request. Existing names are untouched.
export function folderCreationName(input, platform = process.platform) {
  const name = typeof input === "string" ? input.trim() : "";
  if (!name || name.startsWith(".") || /[/\\:\x00-\x1f]/.test(input) || Buffer.byteLength(name) > 255)
    throw Error("请输入有效文件夹名称，不能包含斜线、冒号或以点开头");
  if (platform === "win32") {
    // Check the untrimmed suffix: silently trimming would hide a Windows
    // trailing-space alias. Keep the existing leading whitespace behavior.
    const deviceBase = name.split(".")[0].replace(/ +$/, "");
    if (/[<>"|?*]/.test(name) || /[. ]$/.test(input) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i.test(deviceBase))
      throw Error("Windows 文件夹名称不能使用设备保留名、非法字符，或以点、空格结尾");
  }
  return name;
}
