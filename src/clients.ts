// src/clients.ts
import { google, docs_v1, drive_v3, sheets_v4, script_v1, gmail_v1, calendar_v3 } from 'googleapis';
import { UserError } from 'fastmcp';
import { OAuth2Client } from 'google-auth-library';
import { authorize } from './auth.js';
import { logger } from './logger.js';
import { requestClients } from './remoteWrapper.js';
import { assertReadable, assertOwned } from './approvedFiles.js';

type IdExtractor = (params: any) => string | undefined;

/**
 * Wraps a client method so that a guard runs before delegating to the original
 * method. Marks wrapped methods to avoid double-wrapping on re-init paths.
 */
function wrapMethod(
  owner: any,
  methodName: string,
  guard: (params: any) => Promise<void>,
  extractId: IdExtractor
) {
  const original = owner[methodName];
  if (typeof original !== 'function' || original.__accessGuarded) return;
  const bound = original.bind(owner);
  const wrapped = async (params: any, ...rest: any[]) => {
    const id = extractId(params);
    if (id) await guard(params);
    return bound(params, ...rest);
  };
  (wrapped as any).__accessGuarded = true;
  owner[methodName] = wrapped;
}

/**
 * Wraps the Sheets client so that reads require the spreadsheet to be in the
 * approved list (readonly or owner), and writes require it to be owned by the
 * app. Mutates and returns the passed-in client.
 */
function wrapSheetsWithAccessGuard(sheets: sheets_v4.Sheets): sheets_v4.Sheets {
  const extractId: IdExtractor = (p) =>
    p && typeof p.spreadsheetId === 'string' ? p.spreadsheetId : undefined;

  const readGuard = async (params: any) => {
    const id = extractId(params);
    if (id) await assertReadable(id);
  };
  const writeGuard = async (params: any) => {
    const id = extractId(params);
    if (id) await assertOwned(id);
  };

  const s: any = sheets.spreadsheets;
  // Reads
  wrapMethod(s, 'get', readGuard, extractId);
  wrapMethod(s, 'getByDataFilter', readGuard, extractId);
  // Writes: schema changes (add sheet, formatting, tables, charts, grouping, etc.)
  wrapMethod(s, 'batchUpdate', writeGuard, extractId);

  const v: any = s.values;
  // Reads
  wrapMethod(v, 'get', readGuard, extractId);
  wrapMethod(v, 'batchGet', readGuard, extractId);
  wrapMethod(v, 'batchGetByDataFilter', readGuard, extractId);
  // Writes
  wrapMethod(v, 'update', writeGuard, extractId);
  wrapMethod(v, 'append', writeGuard, extractId);
  wrapMethod(v, 'clear', writeGuard, extractId);
  wrapMethod(v, 'batchUpdate', writeGuard, extractId);
  wrapMethod(v, 'batchClear', writeGuard, extractId);
  wrapMethod(v, 'batchUpdateByDataFilter', writeGuard, extractId);
  wrapMethod(v, 'batchClearByDataFilter', writeGuard, extractId);

  return sheets;
}

/**
 * Wraps the Docs client so that reads require the doc to be in the approved
 * list, and writes require it to be owned by the app.
 */
function wrapDocsWithAccessGuard(docs: docs_v1.Docs): docs_v1.Docs {
  const extractId: IdExtractor = (p) =>
    p && typeof p.documentId === 'string' ? p.documentId : undefined;

  const readGuard = async (params: any) => {
    const id = extractId(params);
    if (id) await assertReadable(id);
  };
  const writeGuard = async (params: any) => {
    const id = extractId(params);
    if (id) await assertOwned(id);
  };

  const d: any = docs.documents;
  wrapMethod(d, 'get', readGuard, extractId);
  wrapMethod(d, 'batchUpdate', writeGuard, extractId);

  return docs;
}

const isRemote = process.env.MCP_TRANSPORT === 'httpStream';

let authClient: OAuth2Client | null = null;
let googleDocs: docs_v1.Docs | null = null;
let googleDrive: drive_v3.Drive | null = null;
let googleSheets: sheets_v4.Sheets | null = null;
let googleScript: script_v1.Script | null = null;
let googleGmail: gmail_v1.Gmail | null = null;
let googleCalendar: calendar_v3.Calendar | null = null;

// --- Initialization ---
export async function initializeGoogleClient() {
  if (googleDocs && googleDrive && googleSheets)
    return {
      authClient,
      googleDocs,
      googleDrive,
      googleSheets,
      googleScript,
      googleGmail,
      googleCalendar,
    };
  if (!authClient) {
    try {
      logger.info('Attempting to authorize Google API client...');
      const client = await authorize();
      authClient = client;
      googleDocs = wrapDocsWithAccessGuard(google.docs({ version: 'v1', auth: authClient }));
      googleDrive = google.drive({ version: 'v3', auth: authClient });
      googleSheets = wrapSheetsWithAccessGuard(google.sheets({ version: 'v4', auth: authClient }));
      googleScript = google.script({ version: 'v1', auth: authClient });
      googleGmail = google.gmail({ version: 'v1', auth: authClient });
      googleCalendar = google.calendar({ version: 'v3', auth: authClient });
      logger.info('Google API client authorized successfully.');
    } catch (error) {
      logger.error('FATAL: Failed to initialize Google API client:', error);
      authClient = null;
      googleDocs = null;
      googleDrive = null;
      googleSheets = null;
      googleScript = null;
      googleGmail = null;
      googleCalendar = null;
      throw new Error('Google client initialization failed. Cannot start server tools.');
    }
  }
  if (authClient && !googleDocs) {
    googleDocs = google.docs({ version: 'v1', auth: authClient });
  }
  if (authClient && !googleDrive) {
    googleDrive = google.drive({ version: 'v3', auth: authClient });
  }
  if (authClient && !googleSheets) {
    googleSheets = wrapSheetsWithAccessGuard(google.sheets({ version: 'v4', auth: authClient }));
  }
  if (authClient && !googleScript) {
    googleScript = google.script({ version: 'v1', auth: authClient });
  }
  if (authClient && !googleGmail) {
    googleGmail = google.gmail({ version: 'v1', auth: authClient });
  }
  if (authClient && !googleCalendar) {
    googleCalendar = google.calendar({ version: 'v3', auth: authClient });
  }

  if (!googleDocs || !googleDrive || !googleSheets) {
    throw new Error('Google Docs, Drive, and Sheets clients could not be initialized.');
  }

  return {
    authClient,
    googleDocs,
    googleDrive,
    googleSheets,
    googleScript,
    googleGmail,
    googleCalendar,
  };
}

// --- Helper to get Docs client within tools ---
export async function getDocsClient() {
  const remote = requestClients.getStore();
  if (remote) return remote.docs;
  if (isRemote) {
    throw new UserError('Request context missing. Tool must be called within an MCP request.');
  }
  const { googleDocs: docs } = await initializeGoogleClient();
  if (!docs) {
    throw new UserError(
      'Google Docs client is not initialized. Authentication might have failed during startup or lost connection.'
    );
  }
  return docs;
}

// --- Helper to get Drive client within tools ---
export async function getDriveClient() {
  const remote = requestClients.getStore();
  if (remote) return remote.drive;
  if (isRemote) {
    throw new UserError('Request context missing. Tool must be called within an MCP request.');
  }
  const { googleDrive: drive } = await initializeGoogleClient();
  if (!drive) {
    throw new UserError(
      'Google Drive client is not initialized. Authentication might have failed during startup or lost connection.'
    );
  }
  return drive;
}

// --- Helper to get Sheets client within tools ---
export async function getSheetsClient() {
  const remote = requestClients.getStore();
  if (remote) return remote.sheets;
  if (isRemote) {
    throw new UserError('Request context missing. Tool must be called within an MCP request.');
  }
  const { googleSheets: sheets } = await initializeGoogleClient();
  if (!sheets) {
    throw new UserError(
      'Google Sheets client is not initialized. Authentication might have failed during startup or lost connection.'
    );
  }
  return sheets;
}

// --- Helper to get Auth client for direct API usage ---
export async function getAuthClient() {
  const remote = requestClients.getStore();
  if (remote) return remote.auth;
  if (isRemote) {
    throw new UserError('Request context missing. Tool must be called within an MCP request.');
  }
  const { authClient: client } = await initializeGoogleClient();
  if (!client) {
    throw new UserError(
      'Auth client is not initialized. Authentication might have failed during startup or lost connection.'
    );
  }
  return client;
}

// --- Helper to get Script client within tools ---
export async function getScriptClient() {
  const remote = requestClients.getStore();
  if (remote) return remote.script;
  if (isRemote) {
    throw new UserError('Request context missing. Tool must be called within an MCP request.');
  }
  const { googleScript: script } = await initializeGoogleClient();
  if (!script) {
    throw new UserError(
      'Google Script client is not initialized. Authentication might have failed during startup or lost connection.'
    );
  }
  return script;
}

// --- Helper to get Gmail client within tools ---
export async function getGmailClient() {
  const remote = requestClients.getStore();
  if (remote) return remote.gmail;
  if (isRemote) {
    throw new UserError('Request context missing. Tool must be called within an MCP request.');
  }
  const { googleGmail: gmail } = await initializeGoogleClient();
  if (!gmail) {
    throw new UserError(
      'Gmail client is not initialized. Authentication might have failed during startup or lost connection.'
    );
  }
  return gmail;
}

// --- Helper to get Calendar client within tools ---
export async function getCalendarClient() {
  const remote = requestClients.getStore();
  if (remote) return remote.calendar;
  if (isRemote) {
    throw new UserError('Request context missing. Tool must be called within an MCP request.');
  }
  const { googleCalendar: calendar } = await initializeGoogleClient();
  if (!calendar) {
    throw new UserError(
      'Google Calendar client is not initialized. Authentication might have failed during startup or lost connection.'
    );
  }
  return calendar;
}
