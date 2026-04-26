import type { FastMCP } from 'fastmcp';
import { register as registerRequestDocumentAccess } from './requestDocumentAccess.js';
import { register as registerListApprovedFiles } from './listApprovedFiles.js';
import { register as registerRevokeFileAccess } from './revokeFileAccess.js';

export function registerAccessTools(server: FastMCP) {
  registerRequestDocumentAccess(server);
  registerListApprovedFiles(server);
  registerRevokeFileAccess(server);
}
