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
  if (name === "deepseek") return new DeepSeekProvider();
  if (name === "openai" || name === "openai-compatible") return new OpenAICompatibleProvider();
  throw new Error(`Unknown provider: ${name}`);
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

export class OpenAICompatibleProvider implements LLMProvider {
  name = "openai-compatible";
  private baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  private apiKey = process.env.OPENAI_API_KEY;
  private model = process.env.OPENAI_MODEL;

  supportsStructuredOutput(): boolean {
    return true;
  }

  supportsNativeBatch(): boolean {
    return true;
  }

  async translateBatch(request: BatchRequest): Promise<BatchResult> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is required for openai-compatible provider.");
    if (!this.model) throw new Error("OPENAI_MODEL is required for openai-compatible provider.");

    const response = await retryFetch(`${this.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          { role: "system", content: systemPrompt() },
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

export class DeepSeekProvider implements LLMProvider {
  name = "deepseek";
  private baseUrl = process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.deepseek.com";
  private apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  private model = process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || "deepseek-v4-flash";

  supportsStructuredOutput(): boolean {
    return true;
  }

  supportsNativeBatch(): boolean {
    return false;
  }

  async translateBatch(request: BatchRequest): Promise<BatchResult> {
    if (!this.apiKey) throw new Error("DEEPSEEK_API_KEY or OPENAI_API_KEY is required for deepseek provider.");
    const response = await retryFetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt() },
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
    if (!response.ok) throw new Error(`DeepSeek request failed ${response.status}: ${redactSecrets(JSON.stringify(json).slice(0, 1000))}`);
    const content = (((json.choices as unknown[])?.[0] as { message?: { content?: string } } | undefined)?.message?.content || "").trim();
    if (!content) throw new Error("DeepSeek returned empty content.");
    const parsed = JSON.parse(content) as { translations?: Array<{ unitId: string; target: string }> };
    if (!Array.isArray(parsed.translations)) throw new Error("Provider JSON is missing translations array.");
    return { requestId: request.requestId, translations: parsed.translations, raw: { usage: json.usage, model: json.model } };
  }
}

function systemPrompt(): string {
  return [
    "You are a localization engine for RPG Maker games.",
    "Translate natural-language game UI and dialogue into the requested target language.",
    "Preserve every placeholder token exactly, for example <PH_0/>.",
    "Do not add markdown, comments, or explanations.",
    "Return only JSON with this shape: {\"translations\":[{\"unitId\":\"...\",\"target\":\"...\"}]}."
  ].join("\n");
}

function providerPayload(request: BatchRequest): Record<string, unknown> {
  return {
    targetLang: request.targetLang,
    units: request.units.map(unit => ({
      unitId: unit.unitId,
      text: unit.protectedSource,
      semanticHint: unit.semanticHint,
      context: unit.context
    }))
  };
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
