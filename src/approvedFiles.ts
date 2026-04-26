// src/approvedFiles.ts
//
// Local persistence for files Claude is allowed to touch. Two modes:
//   - 'readonly': picker-granted by the user; reads allowed, writes blocked.
//   - 'owner': created by the app itself (createDocument / createSpreadsheet /
//     createDocumentFromTemplate / copyFile); reads and writes allowed.
//
// Any file not in this list is treated as forbidden — reads and writes both
// reject. This closes the gap where the broad `documents` / `spreadsheets`
// OAuth scopes would otherwise allow access to arbitrary files by ID.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { UserError } from 'fastmcp';

export type ApprovalMode = 'readonly' | 'owner';

export interface ApprovedFile {
  fileId: string;
  name: string;
  mimeType: string;
  mode: ApprovalMode;
  grantedAt: string;
  purpose?: string;
}

function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || path.join(os.homedir(), '.config');
  const baseDir = path.join(base, 'google-docs-mcp');
  const profile = process.env.GOOGLE_MCP_PROFILE;
  if (profile && !/^[\w-]+$/.test(profile)) {
    throw new Error(
      'GOOGLE_MCP_PROFILE must contain only alphanumeric characters, hyphens, or underscores.'
    );
  }
  return profile ? path.join(baseDir, profile) : baseDir;
}

function getApprovedPath(): string {
  return path.join(getConfigDir(), 'approved-files.json');
}

export async function loadApproved(): Promise<ApprovedFile[]> {
  try {
    const content = await fs.readFile(getApprovedPath(), 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function saveApproved(list: ApprovedFile[]): Promise<void> {
  const dir = getConfigDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(getApprovedPath(), JSON.stringify(list, null, 2), { mode: 0o600 });
}

export async function addApproved(entry: ApprovedFile): Promise<void> {
  const list = await loadApproved();
  const filtered = list.filter((f) => f.fileId !== entry.fileId);
  filtered.push(entry);
  await saveApproved(filtered);
}

export async function addOwned(params: {
  fileId: string;
  name: string;
  mimeType: string;
  purpose?: string;
}): Promise<void> {
  await addApproved({
    fileId: params.fileId,
    name: params.name,
    mimeType: params.mimeType,
    mode: 'owner',
    grantedAt: new Date().toISOString(),
    purpose: params.purpose,
  });
}

export async function removeApproved(fileId: string): Promise<boolean> {
  const list = await loadApproved();
  const filtered = list.filter((f) => f.fileId !== fileId);
  if (filtered.length === list.length) return false;
  await saveApproved(filtered);
  return true;
}

export async function getApproval(fileId: string): Promise<ApprovedFile | null> {
  const list = await loadApproved();
  return list.find((f) => f.fileId === fileId) ?? null;
}

/**
 * Throws UserError if the given fileId is not in the approved list at all.
 * Applied before reads to prevent Claude from accessing arbitrary files by ID.
 */
export async function assertReadable(fileId: string): Promise<void> {
  const approval = await getApproval(fileId);
  if (!approval) {
    throw new UserError(
      `File "${fileId}" is not in the approved list. ` +
        `Use requestDocumentAccess to grant read access via the Google Picker, ` +
        `or create the file with this app first.`
    );
  }
}

/**
 * Throws UserError if the given fileId is not in the approved list as owner
 * (i.e., was created by the app). Picker-granted readonly files and unknown
 * files both reject. Applied before any mutation.
 */
export async function assertOwned(fileId: string): Promise<void> {
  const approval = await getApproval(fileId);
  if (!approval) {
    throw new UserError(
      `File "${fileId}" is not in the approved list. Writes are only allowed ` +
        `to files created by this app. Create a new file instead.`
    );
  }
  if (approval.mode !== 'owner') {
    throw new UserError(
      `File "${approval.name}" (${fileId}) was granted as read-only via the picker. ` +
        `Writes are blocked. Create a new file instead.`
    );
  }
}

/**
 * Backwards-compat alias. Existing call sites (docs helpers, drive tools,
 * sheets proxy) use assertWritable; behavior is now strict owner-only.
 */
export const assertWritable = assertOwned;
