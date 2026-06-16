export type EngineName = "RM2K" | "RM2K3" | "XP" | "VX" | "VXA" | "MV" | "MZ" | "RENPY" | "TYRANO" | "UNKNOWN";

export type TranslationAction = "AUTO" | "REVIEW" | "SKIP" | "LOCKED";

export type SemanticHint =
  | "dialogue"
  | "choice"
  | "description"
  | "name"
  | "system_term"
  | "script"
  | "formula"
  | "resource"
  | "comment"
  | "unknown";

export type EligibilityCategory =
  | "ok"
  | "empty"
  | "already_translated"
  | "too_short"
  | "symbol_only"
  | "resource"
  | "code"
  | "placeholder_only";

export interface EligibilityResult {
  ok: boolean;
  reason: string;
  category: EligibilityCategory;
}

export interface PretranslateOccurrence {
  file: string;
  path: string;
  semanticHint: SemanticHint;
  fieldName?: string;
  commandCode?: number;
  action: "translate" | "review";
  eligibility: EligibilityResult;
}

export interface RuntimeProfile {
  projectId: string;
  sourceRoot: string;
  targetLang: string;
  workRoot: string;
  extractedRoot: string;
  outputRoot: string;
  engine: {
    family: "RPG_MAKER" | "REN_PY" | "TYRANO";
    name: EngineName;
    detectedBy: string[];
    confidence: number;
  };
  data: {
    format: "json" | "marshal" | "lcf" | "renpy" | "tyrano" | "unknown";
    encoding: string;
    root: string;
    files: string[];
  };
  scriptRuntime: {
    language: "javascript" | "ruby" | "python" | "none" | "unknown";
    runtime: "nwjs" | "rgss" | "rgss2" | "rgss3" | "renpy" | "tyrano" | "none" | "unknown";
    engineVersion?: string;
  };
  archive?: {
    path: string;
    kind: "RGSSAD";
    version: 1 | 2 | 3;
    sha256: string;
  };
  plugins?: {
    managerFile?: string;
    loaded: Array<{ name: string; status: boolean; parametersHash?: string }>;
  };
  safety: {
    scriptTranslationDefault: "skip" | "advanced";
    allowRuntimeExecution: boolean;
    networkDisabledInRunner: boolean;
  };
}

export interface NativeNode {
  nodeId: string;
  engine: EngineName;
  file: string;
  path: string;
  pathJson: unknown;
  encoding: string;
  containerKind:
    | "database"
    | "map"
    | "event"
    | "event_command"
    | "plugin_parameter"
    | "script_section"
    | "notetag"
    | "resource_reference";
  fieldName?: string;
  commandCode?: number;
  commandName?: string;
  parameterIndex?: number;
  rawValue: string;
  valueType: "string";
  semanticHint: SemanticHint;
  mutability: "translatable" | "review" | "skip" | "locked";
}

export interface Placeholder {
  id: string;
  raw: string;
  kind: string;
  allowReorder: boolean;
}

export interface PlaceholderSet {
  source: string;
  protected: string;
  placeholders: Placeholder[];
}

export interface TranslationUnit {
  unitId: string;
  engine: EngineName;
  file: string;
  path: string;
  pathJson: unknown;
  source: string;
  protectedSource: string;
  placeholders: Placeholder[];
  action: TranslationAction;
  semanticHint: SemanticHint;
  status: "new" | "planned" | "translated" | "skipped" | "locked" | "error";
  target?: string;
  restoredTarget?: string;
  sourceHash: string;
  context: Record<string, unknown>;
  commandCode?: number;
  fieldName?: string;
}

export interface Issue {
  issueId: string;
  severity: "fatal" | "error" | "warning" | "info";
  type: string;
  engine?: EngineName;
  file?: string;
  path?: string;
  unitId?: string;
  message: string;
  payload?: unknown;
  createdAt: string;
}

export interface ProjectSummary {
  projectId: string;
  sourceRoot: string;
  targetLang: string;
  engine: EngineName;
  outputRoot: string;
  totalUnits: number;
  autoUnits: number;
  reviewUnits: number;
  skippedUnits: number;
  lockedUnits: number;
  translatedUnits: number;
  fatalIssues: number;
  errors: number;
  warnings: number;
}

export interface BatchRequest {
  requestId: string;
  units: TranslationUnit[];
  targetLang: string;
  placeholderRetry?: boolean;
}

export interface BatchResult {
  requestId: string;
  translations: Array<{ unitId: string; target: string }>;
  raw?: unknown;
}

export interface LLMProvider {
  name: string;
  supportsStructuredOutput(): boolean;
  supportsNativeBatch(): boolean;
  translateBatch(request: BatchRequest): Promise<BatchResult>;
}
