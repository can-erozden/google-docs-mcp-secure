import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { getAuthClient } from '../../clients.js';
import { runPickerFlow, loadPickerApiKey, extractAppIdFromClientId } from '../../picker.js';
import { addApproved } from '../../approvedFiles.js';

export function register(server: FastMCP) {
  server.addTool({
    name: 'requestDocumentAccess',
    description:
      'Opens a Google Picker in the browser for the user to select Google Docs to grant Claude READ-ONLY access to. ' +
      'Use this when the user wants Claude to read an existing document they own or have access to. ' +
      'Returns the selected file IDs and names. Picker-granted files are recorded locally and blocked from edits.',
    parameters: z.object({
      purpose: z
        .string()
        .min(1)
        .describe(
          'Short human-readable reason shown to the user in the picker page (e.g. "read tech design draft to use as input").'
        ),
    }),
    execute: async (args, { log }) => {
      const authClient = await getAuthClient();
      if (!(authClient instanceof OAuth2Client)) {
        throw new UserError(
          'requestDocumentAccess requires an OAuth user session. Service account auth is not supported.'
        );
      }

      const tokenInfo = await authClient.getAccessToken();
      const accessToken = tokenInfo.token;
      if (!accessToken) {
        throw new UserError('Could not obtain an access token. Try re-running `node dist/index.js auth`.');
      }

      const clientId = (authClient as any)._clientId as string | undefined;
      if (!clientId) {
        throw new UserError('OAuth client ID unavailable — cannot derive picker App ID.');
      }
      const appId = extractAppIdFromClientId(clientId);

      let apiKey: string;
      try {
        apiKey = await loadPickerApiKey();
      } catch (err: any) {
        throw new UserError(err.message);
      }

      log.info(`Opening picker for purpose: "${args.purpose}"`);

      let picked;
      try {
        picked = await runPickerFlow({ apiKey, accessToken, appId, purpose: args.purpose });
      } catch (err: any) {
        throw new UserError(`Picker failed: ${err.message}`);
      }

      const now = new Date().toISOString();
      for (const file of picked) {
        await addApproved({
          fileId: file.fileId,
          name: file.name,
          mimeType: file.mimeType,
          mode: 'readonly',
          grantedAt: now,
          purpose: args.purpose,
        });
      }

      return JSON.stringify(
        {
          grantedCount: picked.length,
          files: picked.map((f) => ({ fileId: f.fileId, name: f.name, mimeType: f.mimeType })),
          mode: 'readonly',
        },
        null,
        2
      );
    },
  });
}
