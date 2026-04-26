import type { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { loadApproved } from '../../approvedFiles.js';

export function register(server: FastMCP) {
  server.addTool({
    name: 'listApprovedFiles',
    description:
      'Lists files the user has granted Claude access to via the Google Picker (requestDocumentAccess). ' +
      'Shows file ID, name, access mode (readonly), and grant timestamp.',
    parameters: z.object({}),
    execute: async () => {
      const list = await loadApproved();
      return JSON.stringify(
        {
          count: list.length,
          files: list,
        },
        null,
        2
      );
    },
  });
}
