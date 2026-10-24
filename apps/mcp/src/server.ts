import { randomBytes } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { XoApi } from './api-client.js';
import { callTool, UnknownToolError } from './call.js';
import { silentLogger, type DiagLogger } from './logger.js';
import { discoverTools } from './tools.js';

/**
 * P1.1 M5 — the MCP server. Scope (owner-recovered decisions): stdio transport; `tools` only. NO resources, prompts, sampling,
 * elicitation, logging capability, remote transport, OAuth, or approval tool. Capability negotiation advertises exactly `tools`.
 */

export const MCP_SERVER_NAME = 'xo-mcp';
export const MCP_SERVER_VERSION = '0.1.0';

export interface CreateServerOptions {
  readonly api: XoApi;
  readonly logger?: DiagLogger;
  /** Distinguishes this process's idempotency keys from any other session's. Injectable for tests. */
  readonly sessionNonce?: string;
}

const KEY_SAFE = /[^A-Za-z0-9._:-]/g;

export function createMcpServer(options: CreateServerOptions): Server {
  const logger = options.logger ?? silentLogger;
  const nonce = options.sessionNonce ?? randomBytes(9).toString('base64url').replace(KEY_SAFE, '0');
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        'Tools are approved XO procedure versions. Listing a tool grants nothing; the XO API re-checks approval, permissions and input on every call. ' +
        'If a result says the outcome is unknown, do not retry: an external effect may have occurred.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const found = await discoverTools(options.api, extra.signal);
    if (found.kind === 'failed') {
      logger.warn('tools_list_failed', { reason: found.api.kind === 'api_error' ? `http_${found.api.status}` : found.api.reason });
      // A discovery failure is a protocol error; an EMPTY list would falsely say "nothing is available".
      throw new McpError(
        ErrorCode.InternalError,
        found.api.kind === 'api_error'
          ? `XO API refused tool discovery (HTTP ${found.api.status}${found.api.code !== undefined ? `, ${found.api.code}` : ''})`
          : `XO API could not be reached for tool discovery (${found.api.reason})`,
      );
    }
    if (found.truncated) logger.warn('tools_list_truncated');
    logger.info('tools_list', { count: found.tools.length });
    return { tools: found.tools.map((t) => ({ ...t, inputSchema: { ...t.inputSchema, required: [...t.inputSchema.required] } })) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const key = `mcp-${nonce}-${String(extra.requestId)}`.replace(KEY_SAFE, '_').slice(0, 128);
    try {
      const out = await callTool(options.api, {
        name: request.params.name,
        arguments: request.params.arguments,
        idempotencyKey: key,
        signal: extra.signal,
      });
      logger.info('tools_call', { tool: request.params.name.slice(0, 128), error: out.isError });
      return { content: [{ type: 'text' as const, text: out.text }], structuredContent: { ...out.structured }, isError: out.isError };
    } catch (cause) {
      if (cause instanceof UnknownToolError) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
      logger.warn('tools_call_internal_error');
      // Never surface an arbitrary thrown value (it could carry request details).
      throw new McpError(ErrorCode.InternalError, 'internal adapter error; whether anything was started is not established');
    }
  });

  return server;
}
