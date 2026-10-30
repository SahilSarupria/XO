import { AiError, ErrorCode } from '@xo/errors';
import type {
  ModelProvider,
  ProviderCapabilityDescriptor,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderToolCall,
  ProviderToolDefinition,
} from '../provider-types.js';

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Thinking-token budget for thinking-capable models (0 disables thinking where the model allows it,
   * -1 = dynamic). Omitted = the model's own default. Thinking tokens count against `maxOutputTokens`, so a
   * small output cap on a thinking model can end with an empty answer and `finishReason: 'length'`.
   */
  readonly thinkingBudget?: number;
}

interface GeminiPart {
  readonly text?: string;
  readonly thought?: boolean;
  readonly thoughtSignature?: string;
  readonly functionCall?: { readonly id?: string; readonly name?: string; readonly args?: Record<string, unknown> };
}

interface GeminiGenerateContentResponse {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly GeminiPart[] };
    readonly finishReason?: string;
  }[];
  readonly promptFeedback?: { readonly blockReason?: string };
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly thoughtsTokenCount?: number;
    readonly toolUsePromptTokenCount?: number;
  };
}

type JsonObject = Record<string, unknown>;

/** Prefix of ids this adapter invents (Gemini's generateContent usually returns function calls without ids). */
const SYNTH_ID_PREFIX = 'gemini_call_';

/**
 * Real Gemini `generateContent` integration, including function calling.
 *
 * Gemini differs from the other vendors in ways that matter for tool use, all handled here:
 *  - no `system` role (folded into `systemInstruction`) and `user`/`model` role names;
 *  - tool calls are `functionCall` parts and results are `functionResponse` parts matched **by function name**,
 *    not by id — the adapter invents stable ids for the vendor-neutral `ProviderToolCall` and maps them back;
 *  - thinking models attach a `thoughtSignature` to function-call parts that must be echoed back
 *    (carried in `ProviderToolCall.providerState`);
 *  - the declaration schema is an OpenAPI subset: unsupported keywords are dropped or rejected, and a free-form
 *    object parameter (an `object` with no `properties`) is not expressible, so it is declared as a JSON-encoded
 *    string and decoded again on the way back (see `toGeminiSchema` / `restoreFreeform`);
 *  - thinking tokens are billed as output and reported separately; they are added to `outputTokens` so cost and
 *    token budgets are not understated.
 *
 * The API key is sent in the `x-goog-api-key` header, never in the URL, so it cannot leak into logs or URLs.
 *
 * NOT live-verified in the environment this was written in (no route to the Gemini API): request/response mapping
 * is covered by mocked-transport tests only. Run `xo ab-eval --limit 2` against the real API before trusting it.
 */
export class GeminiProvider implements ModelProvider {
  readonly id = 'gemini' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private callSeq = 0;

  constructor(private readonly options: GeminiProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://generativelanguage.googleapis.com';
  }

  describeCapabilities(): ProviderCapabilityDescriptor {
    return {
      providerId: 'gemini',
      models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsToolCalling: true,
      maxContextTokens: 1_000_000,
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const systemText = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const contents = toGeminiContents(request.messages);

    const declared = (request.tools ?? []).map((t) => declareTool(t));
    const freeformByTool = new Map(declared.map((d) => [d.name, d.source] as const));

    const thinking =
      this.options.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: this.options.thinkingBudget } } : undefined;

    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.options.apiKey },
      body: JSON.stringify({
        contents,
        systemInstruction: systemText.length > 0 ? { parts: [{ text: systemText }] } : undefined,
        tools: declared.length > 0 ? [{ functionDeclarations: declared.map((d) => d.declaration) }] : undefined,
        generationConfig: {
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature,
          responseMimeType: request.responseSchema ? 'application/json' : undefined,
          responseSchema: request.responseSchema,
          ...thinking,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AiError(
        ErrorCode.AI_PROVIDER_REQUEST_FAILED,
        `Gemini API returned ${response.status}: ${redact(body, this.options.apiKey)}`,
      );
    }

    const data = (await response.json()) as GeminiGenerateContentResponse;
    const candidate = data.candidates?.[0];
    if (candidate === undefined) {
      const reason = data.promptFeedback?.blockReason;
      if (reason !== undefined) {
        return {
          text: '',
          usage: usageOf(data),
          modelUsed: request.model,
          finishReason: 'content_filter',
        };
      }
      throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, 'Gemini API returned no candidates');
    }

    const parts = candidate.content?.parts ?? [];
    const text = parts
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? '')
      .join('');

    const toolCalls: ProviderToolCall[] = [];
    for (const p of parts) {
      const fc = p.functionCall;
      if (fc === undefined || typeof fc.name !== 'string' || fc.name.length === 0) continue;
      const source = freeformByTool.get(fc.name);
      const args = restoreFreeform(fc.args ?? {}, source) as JsonObject;
      toolCalls.push({
        id: typeof fc.id === 'string' && fc.id.length > 0 ? fc.id : `${SYNTH_ID_PREFIX}${++this.callSeq}`,
        name: fc.name,
        input: args,
        ...(typeof p.thoughtSignature === 'string' ? { providerState: p.thoughtSignature } : {}),
      });
    }

    return {
      text,
      usage: usageOf(data),
      modelUsed: request.model,
      finishReason: toolCalls.length > 0 ? 'tool_use' : mapFinishReason(candidate.finishReason),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}

function usageOf(data: GeminiGenerateContentResponse): ProviderResponse['usage'] {
  const u = data.usageMetadata;
  // Missing usage would silently report 0 tokens and understate cost/budgets; refuse instead.
  if (u === undefined) throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, 'Gemini API returned no usageMetadata');
  return {
    inputTokens: (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0),
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
}

function redact(body: string, apiKey: string): string {
  return apiKey.length > 0 ? body.split(apiKey).join('[redacted]') : body;
}

/**
 * Maps vendor-neutral messages onto Gemini `contents`. Tool results are matched to calls by function *name*, so the
 * name is recovered from the assistant message that issued the call; a result whose call id is unknown is rejected
 * (fail closed) rather than sent as an unattributable response. Consecutive tool results (parallel calls) are merged
 * into one `user` turn, which the API requires.
 */
export function toGeminiContents(messages: readonly ProviderMessage[]): { role: 'user' | 'model'; parts: JsonObject[] }[] {
  const out: { role: 'user' | 'model'; parts: JsonObject[] }[] = [];
  const nameById = new Map<string, string>();
  let lastWasToolResult = false;

  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      const id = m.toolCallId;
      const name = id !== undefined ? nameById.get(id) : undefined;
      if (id === undefined || name === undefined)
        throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, `gemini: tool result references unknown tool call id "${String(id)}"`);
      const part: JsonObject = {
        functionResponse: {
          name,
          ...(id.startsWith(SYNTH_ID_PREFIX) ? {} : { id }),
          response: m.isError === true ? { error: m.content } : { output: m.content },
        },
      };
      const last = out[out.length - 1];
      if (lastWasToolResult && last !== undefined) last.parts.push(part);
      else out.push({ role: 'user', parts: [part] });
      lastWasToolResult = true;
      continue;
    }

    lastWasToolResult = false;
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      const parts: JsonObject[] = [];
      if (m.content.length > 0) parts.push({ text: m.content });
      for (const c of m.toolCalls) {
        nameById.set(c.id, c.name);
        parts.push({
          functionCall: { name: c.name, args: { ...c.input }, ...(c.id.startsWith(SYNTH_ID_PREFIX) ? {} : { id: c.id }) },
          ...(c.providerState !== undefined ? { thoughtSignature: c.providerState } : {}),
        });
      }
      out.push({ role: 'model', parts });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  }
  return out;
}

function mapFinishReason(reason: string | undefined): ProviderResponse['finishReason'] {
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (
    reason === 'SAFETY' ||
    reason === 'RECITATION' ||
    reason === 'BLOCKLIST' ||
    reason === 'PROHIBITED_CONTENT' ||
    reason === 'SPII' ||
    reason === 'IMAGE_SAFETY'
  )
    return 'content_filter';
  return 'error';
}

// ---------------------------------------------------------------------------------------------------------------
// Tool schema translation (JSON Schema -> Gemini's OpenAPI subset)
// ---------------------------------------------------------------------------------------------------------------

/** Keywords that change meaning if dropped; a tool using one is refused rather than silently weakened. */
const REJECTED_KEYWORDS = ['$ref', '$defs', 'definitions', 'allOf', 'not', 'if', 'then', 'else', 'patternProperties', 'dependentSchemas'];
const COPIED_SCALARS = ['description', 'title', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern'] as const;
const FREEFORM_NOTE = ' (provide this value as a JSON-encoded object string)';

function fail(toolName: string, why: string): never {
  throw new AiError(ErrorCode.AI_PROVIDER_REQUEST_FAILED, `gemini: tool "${toolName}" cannot be declared: ${why}`);
}

function isObj(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFreeformObject(node: JsonObject): boolean {
  const types = Array.isArray(node['type']) ? node['type'] : [node['type']];
  if (!types.includes('object')) return false;
  const props = node['properties'];
  return !isObj(props) || Object.keys(props).length === 0;
}

function toGeminiSchema(toolName: string, node: unknown, path: string): JsonObject {
  if (!isObj(node)) fail(toolName, `schema at ${path} is not an object`);
  for (const k of REJECTED_KEYWORDS) if (k in node) fail(toolName, `schema at ${path} uses unsupported keyword "${k}"`);

  const out: JsonObject = {};
  for (const k of COPIED_SCALARS) if (node[k] !== undefined) out[k] = node[k];

  const alt = node['anyOf'] ?? node['oneOf'];
  if (Array.isArray(alt)) {
    out['anyOf'] = alt.map((s, i) => toGeminiSchema(toolName, s, `${path}.anyOf[${i}]`));
    return out;
  }

  let type = node['type'];
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null');
    if (nonNull.length !== type.length) out['nullable'] = true;
    if (nonNull.length === 1) type = nonNull[0];
    else {
      out['anyOf'] = nonNull.map((t) => toGeminiSchema(toolName, { ...node, type: t }, path));
      return out;
    }
  }
  if (node['const'] !== undefined) {
    if (typeof node['const'] !== 'string') fail(toolName, `non-string const at ${path}`);
    out['type'] = 'string';
    out['enum'] = [node['const']];
    return out;
  }
  if (typeof type !== 'string') fail(toolName, `schema at ${path} has no usable "type"`);

  if (node['enum'] !== undefined) {
    if (!Array.isArray(node['enum']) || !node['enum'].every((e) => typeof e === 'string'))
      fail(toolName, `enum at ${path} must contain only strings`);
    out['enum'] = node['enum'];
  }

  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      out['type'] = type;
      return out;
    case 'array': {
      if (!isObj(node['items'])) fail(toolName, `array at ${path} has no "items" schema`);
      out['type'] = 'array';
      out['items'] = toGeminiSchema(toolName, node['items'], `${path}.items`);
      return out;
    }
    case 'object': {
      if (isFreeformObject(node)) {
        out['type'] = 'string';
        out['description'] = `${typeof node['description'] === 'string' ? node['description'] : 'object'}${FREEFORM_NOTE}`;
        return out;
      }
      const props = node['properties'] as JsonObject;
      const converted: JsonObject = {};
      for (const [k, v] of Object.entries(props)) converted[k] = toGeminiSchema(toolName, v, `${path}.${k}`);
      out['type'] = 'object';
      out['properties'] = converted;
      if (Array.isArray(node['required'])) {
        const req = node['required'].filter((r): r is string => typeof r === 'string' && r in converted);
        if (req.length > 0) out['required'] = req;
      }
      return out;
    }
    default:
      return fail(toolName, `unsupported type "${type}" at ${path}`);
  }
}

interface DeclaredTool {
  readonly name: string;
  readonly declaration: JsonObject;
  /** The original JSON Schema, kept so decoded arguments can be restored to their declared shape. */
  readonly source: JsonObject | undefined;
}

function declareTool(tool: ProviderToolDefinition): DeclaredTool {
  const source = tool.inputSchema;
  const root = isObj(source) ? source : undefined;
  const declaration: JsonObject = { name: tool.name, description: tool.description };
  // A parameterless tool must omit `parameters` entirely (an empty OBJECT is rejected by the API).
  if (root !== undefined && !isFreeformObject(root)) declaration['parameters'] = toGeminiSchema(tool.name, root, '$');
  return { name: tool.name, declaration, source: root };
}

/**
 * Inverse of the free-form-object shim: wherever the original schema declared an object without properties and the
 * model sent a JSON string, decode it. Anything that does not decode to a plain object is left untouched so the tool
 * executor sees (and can reject) exactly what the model sent.
 */
export function restoreFreeform(value: unknown, schema: JsonObject | undefined): unknown {
  if (schema === undefined) return value;
  if (isFreeformObject(schema)) {
    if (typeof value !== 'string') return value;
    try {
      const parsed: unknown = JSON.parse(value);
      return isObj(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }
  if (isObj(value) && isObj(schema['properties'])) {
    const out: JsonObject = { ...value };
    for (const [k, sub] of Object.entries(schema['properties'])) {
      if (k in out && isObj(sub)) out[k] = restoreFreeform(out[k], sub);
    }
    return out;
  }
  if (Array.isArray(value) && isObj(schema['items'])) return value.map((v) => restoreFreeform(v, schema['items'] as JsonObject));
  return value;
}
