function optionLine(content) {
  const lines = content.split(/\r?\n/);
  const matches = lines.map((line, index) => /^[ \t]*NODE_OPTIONS[ \t]*=/.test(line) ? index : -1).filter(index => index >= 0);
  if (matches.length > 1) throw new Error('The OmniRoute environment has multiple NODE_OPTIONS entries; combine them before setup.');
  return { lines, index: matches[0] ?? -1 };
}

export function readNodeOptions(content) {
  const { lines, index } = optionLine(content);
  if (index < 0) return '';
  const value = lines[index].slice(lines[index].indexOf('=') + 1).trim();
  return ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1) : value;
}

export function addPreload(options, preload) {
  if (/[\r\n\0]/.test(options) || /\s/.test(preload) || new URL(preload).protocol !== 'file:')
    throw new Error('Node options must be a single line and the preload must be a local file URL.');
  const flag = '--import=' + preload;
  return options.split(/\s+/).includes(flag) ? options.trim() : [options.trim(), flag].filter(Boolean).join(' ');
}

export function removePreload(options, preload) {
  if (/[\r\n\0]/.test(options) || /\s/.test(preload) || new URL(preload).protocol !== 'file:')
    throw new Error('Node options must be a single line and the preload must be a local file URL.');
  const flag = '--import=' + preload;
  return options.split(/\s+/).filter(value => value && value !== flag).join(' ');
}

export function updateNodeOptions(content, preload) {
  const { lines, index } = optionLine(content);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const replacement = 'NODE_OPTIONS=' + addPreload(readNodeOptions(content), preload);
  if (index >= 0) { lines[index] = replacement; return lines.join(newline); }
  return content + (content && !content.endsWith('\n') ? newline : '') + replacement + newline;
}

export function removeNodeOptions(content, preload) {
  const { lines, index } = optionLine(content);
  if (index < 0) return content;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  lines[index] = 'NODE_OPTIONS=' + removePreload(readNodeOptions(content), preload);
  return lines.join(newline);
}

export function startupVbs(nodePath, launcherPath, { directory, configPath } = {}) {
  if ([nodePath, launcherPath, directory, configPath].filter(value => value !== undefined)
    .some(value => typeof value !== 'string' || /[\r\n\0"]/.test(value))) throw new Error('Invalid startup path');
  const command = `"${nodePath}" "${launcherPath}" --watch`.replaceAll('"', '""');
  return ["' OmniRoute with persistent Session Sync; installed once.", 'Option Explicit',
    'Dim WshShell, SessionEnv, ExitCode', 'Set WshShell = CreateObject("WScript.Shell")',
    'Set SessionEnv = WshShell.Environment("Process")',
    ...(directory ? [`SessionEnv("OMNI_SYNC_DATA_DIR") = "${directory}"`] : []),
    ...(configPath ? [`SessionEnv("OMNI_SYNC_CONFIG_FILE") = "${configPath}"`] : []),
    `ExitCode = WshShell.Run("${command}", 0, True)`, 'WScript.Quit ExitCode', ''].join('\r\n');
}
