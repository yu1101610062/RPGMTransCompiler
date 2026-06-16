import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { BatchRequest, BatchResult, LLMProvider } from "../core/types.js";
import { projectRoot } from "../core/paths.js";

for (const envFile of [".env", ".env.local"]) {
  const full = path.join(projectRoot, envFile);
  if (fs.existsSync(full)) dotenv.config({ path: full, override: true });
}

export function createProvider(name: string): LLMProvider {
  if (name === "mock") return new MockProvider();
  if (name === "mock-bad-placeholder") return new MockBadPlaceholderProvider();
  if (name === "configured") return configuredProvider();
  if (name === "openai" || name === "openai-responses") {
    return new OpenAIResponsesProvider({
      name: "openai-responses",
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL
    });
  }
  if (name === "openai-chat" || name === "openai-compatible") {
    return new OpenAIChatProvider({
      name: "openai-chat",
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL
    });
  }
  if (name === "anthropic") return new AnthropicProvider(configFromEnvironment("anthropic"));
  if (name === "google") return new GoogleProvider(configFromEnvironment("google"));
  if (name === "deepseek") {
    return new OpenAIChatProvider({
      name: "openai-chat",
      baseUrl: process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
      model: process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || "deepseek-v4-flash"
    });
  }
  throw new Error(`Unknown provider: ${name}`);
}

type ProviderConfig = {
  name: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

function configuredProvider(): LLMProvider {
  const format = process.env.RPGMTRANS_PROVIDER_FORMAT;
  if (!format) throw new Error("RPGMTRANS_PROVIDER_FORMAT is required for configured provider.");
  const config = configFromEnvironment(format);
  if (format === "openai-responses") return new OpenAIResponsesProvider(config);
  if (format === "openai-chat") return new OpenAIChatProvider(config);
  if (format === "anthropic") return new AnthropicProvider(config);
  if (format === "google") return new GoogleProvider(config);
  throw new Error(`Unsupported configured provider format: ${format}`);
}

function configFromEnvironment(format: string): ProviderConfig {
  const generic = {
    name: format,
    baseUrl: process.env.RPGMTRANS_PROVIDER_BASE_URL,
    apiKey: process.env.RPGMTRANS_PROVIDER_API_KEY,
    model: process.env.RPGMTRANS_PROVIDER_MODEL
  };
  if (generic.baseUrl || generic.apiKey || generic.model) return generic;
  if (format === "anthropic") {
    return {
      name: format,
      baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1",
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL
    };
  }
  if (format === "google") {
    return {
      name: format,
      baseUrl: process.env.GOOGLE_BASE_URL || process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
      apiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
      model: process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL
    };
  }
  return {
    name: format,
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL
  };
}

export class MockProvider implements LLMProvider {
  name = "mock";

  supportsStructuredOutput(): boolean {
    return true;
  }

  supportsNativeBatch(): boolean {
    return false;
  }

  async translateBatch(request: BatchRequest): Promise<BatchResult> {
    return {
      requestId: request.requestId,
      translations: request.units.map(unit => ({
        unitId: unit.unitId,
        target: `[${request.targetLang}] ${unit.protectedSource}`
      }))
    };
  }
}

export class MockBadPlaceholderProvider implements LLMProvider {
  name = "mock-bad-placeholder";

  supportsStructuredOutput(): boolean {
    return true;
  }

  supportsNativeBatch(): boolean {
    return false;
  }

  async translateBatch(request: BatchRequest): Promise<BatchResult> {
    return {
      requestId: request.requestId,
      translations: request.units.map(unit => ({
        unitId: unit.unitId,
        target: `[${request.targetLang}] ${unit.protectedSource.replace(/<PH_\d+\/>/g, "")}`
      }))
    };
  }
}

export class OpenAIResponsesProvider implements LLMProvider {
  name: string;
  private baseUrl: string;
  private apiKey?: string;
  private model?: string;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl || "https://api.openai.com/v1";
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  supportsStructuredOutput(): boolean {
    return true;
  }

  supportsNativeBatch(): boolean {
    return true;
  }

  async translateBatch(request: BatchRequest): Promise<BatchResult> {
    if (!this.apiKey) throw new Error("API key is required for OpenAI Responses provider.");
    if (!this.model) throw new Error("Model is required for OpenAI Responses provider.");

    const response = await retryFetch(`${this.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          { role: "system", content: systemPrompt(Boolean(request.placeholderRetry)) },
          { role: "user", content: JSON.stringify(providerPayload(request)) }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "rpgm_runtime_translation_batch",
            strict: true,
            schema: translationSchema()
          }
        }
      })
    });
    const json = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`Provider request failed ${response.status}: ${redactSecrets(JSON.stringify(json).slice(0, 1000))}`);
    const parsed = parseStructuredResponse(json);
    return { requestId: request.requestId, translations: parsed.translations, raw: json };
  }
}

export class OpenAIChatProvider implements LLMProvider {
  name: string;
  private baseUrl: string;
  private apiKey?: string;
  private model?: string;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl || "https://api.openai.com/v1";
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  supportsStructuredOutput(): boolean {
    return true;
  }

  supportsNativeBatch(): boolean {
    return false;
  }

  async translateBatch(request: BatchRequest): Promise<BatchResult> {
    if (!this.apiKey) throw new Error("API key is required for OpenAI Chat provider.");
    if (!this.model) throw new Error("Model is required for OpenAI Chat provider.");
    const response = await retryFetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt(Boolean(request.placeholderRetry)) },
          { role: "user", content: JSON.stringify(providerPayload(request)) }
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        temperature: 0.2,
        stream: false,
        max_tokens: 8192
      })
    });
    const json = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`OpenAI Chat request failed ${response.status}: ${redactSecrets(JSON.stringify(json).slice(0, 1000))}`);
    const content = (((json.choices as unknown[])?.[0] as { message?: { content?: string } } | undefined)?.message?.content || "").trim();
    if (!content) throw new Error("OpenAI Chat provider returned empty content.");
    const parsed = JSON.parse(content) as { translations?: Array<{ unitId: string; target: string }> };
    if (!Array.isArray(parsed.translations)) throw new Error("Provider JSON is missing translations array.");
    return { requestId: request.requestId, translations: parsed.translations, raw: { usage: json.usage, model: json.model } };
  }
}

export class AnthropicProvider implements LLMProvider {
  name: string;
  private baseUrl: string;
  private apiKey?: string;
  private model?: string;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl || "https://api.anthropic.com/v1";
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  supportsStructuredOutput(): boolean {
    return true;
  }

  supportsNativeBatch(): boolean {
    return false;
  }

  async translateBatch(request: BatchRequest): Promise<BatchResult> {
    if (!this.apiKey) throw new Error("API key is required for Anthropic provider.");
    if (!this.model) throw new Error("Model is required for Anthropic provider.");
    const response = await retryFetch(`${this.baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 8192,
        temperature: 0.2,
        system: systemPrompt(Boolean(request.placeholderRetry)),
        messages: [
          { role: "user", content: JSON.stringify(providerPayload(request)) }
        ]
      })
    });
    const json = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`Anthropic request failed ${response.status}: ${redactSecrets(JSON.stringify(json).slice(0, 1000))}`);
    const content = Array.isArray(json.content) ? json.content : [];
    const text = content
      .map(part => (part as { text?: unknown }).text)
      .find(value => typeof value === "string") as string | undefined;
    if (!text) throw new Error("Anthropic provider returned empty content.");
    const parsed = JSON.parse(text) as { translations?: Array<{ unitId: string; target: string }> };
    if (!Array.isArray(parsed.translations)) throw new Error("Provider JSON is missing translations array.");
    return { requestId: request.requestId, translations: parsed.translations, raw: { usage: json.usage, model: json.model } };
  }
}

export class GoogleProvider implements LLMProvider {
  name: string;
  private baseUrl: string;
  private apiKey?: string;
  private model?: string;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  supportsStructuredOutput(): boolean {
    return true;
  }

  supportsNativeBatch(): boolean {
    return false;
  }

  async translateBatch(request: BatchRequest): Promise<BatchResult> {
    if (!this.apiKey) throw new Error("API key is required for Google provider.");
    if (!this.model) throw new Error("Model is required for Google provider.");
    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const response = await retryFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: `${systemPrompt(Boolean(request.placeholderRetry))}\n\n${JSON.stringify(providerPayload(request))}` }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    });
    const json = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`Google request failed ${response.status}: ${redactSecrets(JSON.stringify(json).slice(0, 1000))}`);
    const candidates = Array.isArray(json.candidates) ? json.candidates : [];
    const first = candidates[0] as { content?: { parts?: Array<{ text?: string }> } } | undefined;
    const text = first?.content?.parts?.find(part => typeof part.text === "string")?.text;
    if (!text) throw new Error("Google provider returned empty content.");
    const parsed = JSON.parse(text) as { translations?: Array<{ unitId: string; target: string }> };
    if (!Array.isArray(parsed.translations)) throw new Error("Provider JSON is missing translations array.");
    return { requestId: request.requestId, translations: parsed.translations, raw: { usageMetadata: json.usageMetadata, model: this.model } };
  }
}

function systemPrompt(placeholderRetry = false): string {
  const lines = [
    "You are a localization engine for RPG Maker games.",
    "Translate natural-language game UI and dialogue into the requested target language.",
    "Preserve every placeholder token exactly, for example <PH_0/>.",
    "Do not add markdown, comments, or explanations.",
    "Return only JSON with this shape: {\"translations\":[{\"unitId\":\"...\",\"target\":\"...\"}]}."
  ];
  if (placeholderRetry) {
    lines.push("This is a retry after placeholder validation failed. Copy every <PH_n/> token exactly once unless it appears more than once in the input.");
  }
  return lines.join("\n");
}

function providerPayload(request: BatchRequest): Record<string, unknown> {
  return {
    targetLang: request.targetLang,
    units: request.units.map(unit => ({
      unitId: unit.unitId,
      text: unit.protectedSource,
      semanticHint: unit.semanticHint,
      contextCode: compactContextCode(unit),
      commandCode: unit.commandCode ?? null,
      fieldName: unit.fieldName ?? null
    }))
  };
}

function compactContextCode(unit: BatchRequest["units"][number]): string {
  const parts = [
    unit.engine,
    unit.semanticHint,
    unit.fieldName || "",
    unit.commandCode === undefined ? "" : String(unit.commandCode)
  ].filter(Boolean);
  return parts.join(":");
}

function translationSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      translations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            unitId: { type: "string" },
            target: { type: "string" }
          },
          required: ["unitId", "target"]
        }
      }
    },
    required: ["translations"]
  };
}

async function retryFetch(url: string, init: RequestInit): Promise<Response> {
  let attempt = 0;
  while (true) {
    const response = await fetch(url, init);
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= 5) return response;
    const delay = Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
    await new Promise(resolve => setTimeout(resolve, delay));
    attempt++;
  }
}

function parseStructuredResponse(json: Record<string, unknown>): { translations: Array<{ unitId: string; target: string }> } {
  if (typeof json.output_text === "string") return JSON.parse(json.output_text);
  const output = json.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = (item as { content?: unknown[] }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") return JSON.parse(text);
      }
    }
  }
  throw new Error("Unable to parse structured provider response.");
}

function redactSecrets(input: string): string {
  return input
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***");
}
