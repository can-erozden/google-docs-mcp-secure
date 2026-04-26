import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { removeApproved } from '../../approvedFiles.js';

export function register(server: FastMCP) {
  server.addTool({
    name: 'revokeFileAccess',
    description:
      'Removes a file from Claude\'s local approved-files list. ' +
      'Note: this only removes the local record. To fully revoke Drive access, the user must also revoke ' +
      'the app\'s access in their Google Account settings (https://myaccount.google.com/permissions).',
    parameters: z.object({
      fileId: z.string().min(1).describe('The Google Drive file ID to revoke from the local approved list.'),
    }),
    execute: async (args) => {
      const removed = await removeApproved(args.fileId);
      if (!removed) {
        throw new UserError(`File ID "${args.fileId}" was not found in the approved list.`);
      }
      return JSON.stringify(
        {
          fileId: args.fileId,
          revokedLocally: true,
          note: 'To fully revoke Drive access, also remove app access at https://myaccount.google.com/permissions.',
        },
        null,
        2
      );
    },
  });
}
