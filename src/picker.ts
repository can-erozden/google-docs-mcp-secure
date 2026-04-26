// src/picker.ts
//
// Google Picker flow: spin up a local HTTP server, open the browser to a page
// that loads the Google Picker JS SDK, let the user pick files, and return the
// picked file metadata. Picker-granted file access is automatically tied to
// the drive.file OAuth scope — no token upgrade is needed.

import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { logger } from './logger.js';

export interface PickerResult {
  fileId: string;
  name: string;
  mimeType: string;
}

export interface PickerOptions {
  apiKey: string;
  accessToken: string;
  appId: string; // GCP project number (numeric)
  purpose?: string;
  timeoutMs?: number;
}

function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || path.join(os.homedir(), '.config');
  const baseDir = path.join(base, 'google-docs-mcp');
  const profile = process.env.GOOGLE_MCP_PROFILE;
  return profile ? path.join(baseDir, profile) : baseDir;
}

/**
 * Read the Picker API key from env GOOGLE_PICKER_API_KEY or
 * ~/.config/google-docs-mcp/picker-api-key.txt (trimmed).
 */
export async function loadPickerApiKey(): Promise<string> {
  const env = process.env.GOOGLE_PICKER_API_KEY;
  if (env && env.trim()) return env.trim();
  const keyPath = path.join(getConfigDir(), 'picker-api-key.txt');
  try {
    const content = await fs.readFile(keyPath, 'utf8');
    const key = content.trim();
    if (!key) throw new Error('picker-api-key.txt is empty');
    return key;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Google Picker API key not found. Create ${keyPath} with the API key on a single line, ` +
          `or set GOOGLE_PICKER_API_KEY env var.`
      );
    }
    throw err;
  }
}

/**
 * Extract the GCP project number from an OAuth client ID.
 * OAuth client IDs have the form "<project_number>-<hash>.apps.googleusercontent.com".
 */
export function extractAppIdFromClientId(clientId: string): string {
  const match = clientId.match(/^(\d+)-/);
  if (!match) {
    throw new Error(
      `Could not extract project number from OAuth client ID "${clientId}". Expected format "<project_number>-<hash>.apps.googleusercontent.com".`
    );
  }
  return match[1];
}

export async function runPickerFlow(opts: PickerOptions): Promise<PickerResult[]> {
  const {
    apiKey,
    accessToken,
    appId,
    purpose = 'Select files to grant Claude read-only access',
    timeoutMs = 5 * 60 * 1000,
  } = opts;

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  const port = (server.address() as { port: number }).port;

  const state = crypto.randomBytes(16).toString('hex');
  const pickerUrl = `http://localhost:${port}/picker?state=${state}`;

  let timeoutHandle: NodeJS.Timeout | null = null;
  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    server.close();
  };

  const resultPromise = new Promise<PickerResult[]>((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error('Picker flow timed out. No file was selected within 5 minutes.'));
    }, timeoutMs);

    server.on('request', (req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);

      if (url.pathname === '/picker' && req.method === 'GET') {
        if (url.searchParams.get('state') !== state) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid state');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderPickerHtml({ apiKey, accessToken, appId, purpose, state }));
        return;
      }

      if (url.pathname === '/callback' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.state !== state) {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end('Invalid state');
              return;
            }
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
            cleanup();
            if (parsed.cancelled) {
              reject(new Error('User cancelled the picker.'));
            } else if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
              reject(new Error('No files selected.'));
            } else {
              resolve(parsed.files);
            }
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad JSON');
            cleanup();
            reject(err);
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  openInBrowser(pickerUrl);
  logger.info(`Picker URL: ${pickerUrl}`);

  return resultPromise;
}

function openInBrowser(url: string): void {
  // Safari's ITP blocks the cross-site cookies Google Picker needs, so on
  // macOS we prefer Chrome. Override with GOOGLE_PICKER_BROWSER (pass a macOS
  // app name like "Firefox" or "Brave Browser", or "default" for OS default).
  const browserOverride = process.env.GOOGLE_PICKER_BROWSER;

  let cmd: string;
  if (process.platform === 'darwin') {
    if (browserOverride && browserOverride !== 'default') {
      cmd = `open -a ${JSON.stringify(browserOverride)} "${url}"`;
    } else if (browserOverride === 'default') {
      cmd = `open "${url}"`;
    } else {
      cmd = `open -a "Google Chrome" "${url}"`;
    }
  } else if (process.platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      // Fallback: try the OS default browser if the preferred one failed
      if (process.platform === 'darwin' && cmd.includes('-a')) {
        logger.warn(
          `Preferred browser failed (${err.message}); falling back to default. Picker may not work in Safari.`
        );
        exec(`open "${url}"`, (err2) => {
          if (err2) logger.warn(`Could not auto-open browser: ${err2.message}. Open manually: ${url}`);
        });
      } else {
        logger.warn(`Could not auto-open browser: ${err.message}. Open manually: ${url}`);
      }
    }
  });
}

function renderPickerHtml(params: {
  apiKey: string;
  accessToken: string;
  appId: string;
  purpose: string;
  state: string;
}): string {
  const cfg = JSON.stringify(params);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Claude: Grant File Access</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 640px; margin: 80px auto; padding: 24px; color: #1f2937; }
    h1 { font-size: 20px; margin-bottom: 8px; }
    .purpose { background: #f3f4f6; border-left: 3px solid #6366f1; padding: 12px 16px; margin: 16px 0; }
    .hint { color: #6b7280; font-size: 14px; }
    .done { color: #059669; font-weight: 600; }
    .error { color: #dc2626; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Claude is requesting read-only access</h1>
  <div class="purpose"><strong>Purpose:</strong> <span id="purpose"></span></div>
  <p class="hint" id="hint">Loading picker…</p>
  <script src="https://apis.google.com/js/api.js"></script>
  <script>
    const CONFIG = ${cfg};
    document.getElementById('purpose').textContent = CONFIG.purpose;

    gapi.load('picker', { callback: onPickerApiLoad });

    function onPickerApiLoad() {
      const docsView = new google.picker.DocsView(google.picker.ViewId.DOCUMENTS)
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false)
        .setMode(google.picker.DocsViewMode.LIST);

      const sheetsView = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false)
        .setMode(google.picker.DocsViewMode.LIST);

      const picker = new google.picker.PickerBuilder()
        .setAppId(CONFIG.appId)
        .setOAuthToken(CONFIG.accessToken)
        .setDeveloperKey(CONFIG.apiKey)
        .addView(docsView)
        .addView(sheetsView)
        .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .setCallback(pickerCallback)
        .setTitle('Select Google Docs or Sheets to share with Claude')
        .build();

      picker.setVisible(true);
      document.getElementById('hint').textContent = 'Pick one or more files in the dialog.';
    }

    function pickerCallback(data) {
      if (data.action === google.picker.Action.PICKED) {
        const files = (data.docs || []).map(d => ({
          fileId: d.id,
          name: d.name,
          mimeType: d.mimeType
        }));
        postResult({ state: CONFIG.state, files });
      } else if (data.action === google.picker.Action.CANCEL) {
        postResult({ state: CONFIG.state, cancelled: true, files: [] });
      }
    }

    function postResult(payload) {
      fetch('/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(() => {
        const hint = document.getElementById('hint');
        if (payload.cancelled) {
          hint.className = 'error';
          hint.textContent = 'Cancelled. You can close this tab.';
        } else {
          hint.className = 'done';
          hint.textContent = 'Done — granted access to ' + payload.files.length + ' file(s). You can close this tab.';
        }
      }).catch(err => {
        const hint = document.getElementById('hint');
        hint.className = 'error';
        hint.textContent = 'Error posting result: ' + err.message;
      });
    }
  </script>
</body>
</html>`;
}
