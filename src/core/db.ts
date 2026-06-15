import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { Issue, ProjectSummary, RuntimeProfile, TranslationUnit } from "./types.js";

const require = createRequire(import.meta.url);
const sqlite = require("node:sqlite") as {
  DatabaseSync: new (filename: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...values: unknown[]): unknown;
      get(...values: unknown[]): Record<string, unknown> | undefined;
      all(...values: unknown[]): Array<Record<string, unknown>>;
    };
    close(): void;
  };
};

export class ProjectDb {
  private db: InstanceType<typeof sqlite.DatabaseSync>;

  constructor(public readonly filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new sqlite.DatabaseSync(filename);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS translation_units (
        unit_id TEXT PRIMARY KEY,
        engine TEXT NOT NULL,
        file TEXT NOT NULL,
        path TEXT NOT NULL,
        path_json TEXT NOT NULL,
        source TEXT NOT NULL,
        protected_source TEXT NOT NULL,
        placeholders_json TEXT NOT NULL,
        action TEXT NOT NULL,
        semantic_hint TEXT NOT NULL,
        status TEXT NOT NULL,
        target TEXT,
        restored_target TEXT,
        source_hash TEXT NOT NULL,
        context_json TEXT NOT NULL,
        command_code INTEGER,
        field_name TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_translation_units_action ON translation_units(action);
      CREATE INDEX IF NOT EXISTS idx_translation_units_status ON translation_units(status);
      CREATE INDEX IF NOT EXISTS idx_translation_units_file ON translation_units(file);
      CREATE TABLE IF NOT EXISTS issues (
        issue_id TEXT PRIMARY KEY,
        severity TEXT NOT NULL,
        type TEXT NOT NULL,
        engine TEXT,
        file TEXT,
        path TEXT,
        unit_id TEXT,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_issues_severity ON issues(severity);
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        unit_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT
      );
    `);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setJson(key: string, value: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  }

  getJson<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    if (!row) return undefined;
    return JSON.parse(String(row.value)) as T;
  }

  setProfile(profile: RuntimeProfile): void {
    this.setJson("runtime_profile", profile);
  }

  getProfile(): RuntimeProfile {
    const profile = this.getJson<RuntimeProfile>("runtime_profile");
    if (!profile) throw new Error(`No runtime profile in ${this.filename}. Run scan first.`);
    return profile;
  }

  replaceUnits(units: TranslationUnit[]): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM translation_units");
      const stmt = this.db.prepare(`
        INSERT INTO translation_units (
          unit_id, engine, file, path, path_json, source, protected_source,
          placeholders_json, action, semantic_hint, status, target, restored_target,
          source_hash, context_json, command_code, field_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const unit of units) {
        stmt.run(
          unit.unitId,
          unit.engine,
          unit.file,
          unit.path,
          JSON.stringify(unit.pathJson),
          unit.source,
          unit.protectedSource,
          JSON.stringify(unit.placeholders),
          unit.action,
          unit.semanticHint,
          unit.status,
          unit.target ?? null,
          unit.restoredTarget ?? null,
          unit.sourceHash,
          JSON.stringify(unit.context),
          unit.commandCode ?? null,
          unit.fieldName ?? null
        );
      }
    });
  }

  allUnits(filter?: { action?: string; status?: string }): TranslationUnit[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter?.action) {
      clauses.push("action = ?");
      args.push(filter.action);
    }
    if (filter?.status) {
      clauses.push("status = ?");
      args.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM translation_units ${where} ORDER BY file, unit_id`).all(...args);
    return rows.map(rowToUnit);
  }

  getUnit(unitId: string): TranslationUnit | undefined {
    const row = this.db.prepare("SELECT * FROM translation_units WHERE unit_id = ?").get(unitId);
    return row ? rowToUnit(row) : undefined;
  }

  updateUnitTranslation(unitId: string, target: string, restoredTarget: string, status = "translated"): void {
    this.db
      .prepare("UPDATE translation_units SET target = ?, restored_target = ?, status = ? WHERE unit_id = ?")
      .run(target, restoredTarget, status, unitId);
  }

  clearUnitTranslation(unitId: string, status = "new"): void {
    this.db
      .prepare("UPDATE translation_units SET target = NULL, restored_target = NULL, status = ? WHERE unit_id = ?")
      .run(status, unitId);
  }

  markPlanned(unitIds: string[]): void {
    this.transaction(() => {
      const stmt = this.db.prepare("UPDATE translation_units SET status = ? WHERE unit_id = ?");
      for (const unitId of unitIds) stmt.run("planned", unitId);
    });
  }

  replaceIssues(issues: Issue[]): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM issues");
      const stmt = this.db.prepare(`
        INSERT INTO issues (
          issue_id, severity, type, engine, file, path, unit_id, message, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const issue of issues) {
        stmt.run(
          issue.issueId,
          issue.severity,
          issue.type,
          issue.engine ?? null,
          issue.file ?? null,
          issue.path ?? null,
          issue.unitId ?? null,
          issue.message,
          issue.payload === undefined ? null : JSON.stringify(issue.payload),
          issue.createdAt
        );
      }
    });
  }

  addIssues(issues: Issue[]): void {
    this.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO issues (
          issue_id, severity, type, engine, file, path, unit_id, message, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const issue of issues) {
        stmt.run(
          issue.issueId,
          issue.severity,
          issue.type,
          issue.engine ?? null,
          issue.file ?? null,
          issue.path ?? null,
          issue.unitId ?? null,
          issue.message,
          issue.payload === undefined ? null : JSON.stringify(issue.payload),
          issue.createdAt
        );
      }
    });
  }

  allIssues(): Issue[] {
    return this.db.prepare("SELECT * FROM issues ORDER BY severity, issue_id").all().map(rowToIssue);
  }

  summary(): ProjectSummary {
    const profile = this.getProfile();
    const scalar = (sql: string): number => Number(this.db.prepare(sql).get()?.value ?? 0);
    return {
      projectId: profile.projectId,
      sourceRoot: profile.sourceRoot,
      targetLang: profile.targetLang,
      engine: profile.engine.name,
      outputRoot: profile.outputRoot,
      totalUnits: scalar("SELECT COUNT(*) AS value FROM translation_units"),
      autoUnits: scalar("SELECT COUNT(*) AS value FROM translation_units WHERE action = 'AUTO'"),
      reviewUnits: scalar("SELECT COUNT(*) AS value FROM translation_units WHERE action = 'REVIEW'"),
      skippedUnits: scalar("SELECT COUNT(*) AS value FROM translation_units WHERE action = 'SKIP'"),
      lockedUnits: scalar("SELECT COUNT(*) AS value FROM translation_units WHERE action = 'LOCKED'"),
      translatedUnits: scalar("SELECT COUNT(*) AS value FROM translation_units WHERE status = 'translated'"),
      fatalIssues: scalar("SELECT COUNT(*) AS value FROM issues WHERE severity = 'fatal'"),
      errors: scalar("SELECT COUNT(*) AS value FROM issues WHERE severity = 'error'"),
      warnings: scalar("SELECT COUNT(*) AS value FROM issues WHERE severity = 'warning'")
    };
  }
}

function rowToUnit(row: Record<string, unknown>): TranslationUnit {
  return {
    unitId: String(row.unit_id),
    engine: row.engine as TranslationUnit["engine"],
    file: String(row.file),
    path: String(row.path),
    pathJson: JSON.parse(String(row.path_json)),
    source: String(row.source),
    protectedSource: String(row.protected_source),
    placeholders: JSON.parse(String(row.placeholders_json)),
    action: row.action as TranslationUnit["action"],
    semanticHint: row.semantic_hint as TranslationUnit["semanticHint"],
    status: row.status as TranslationUnit["status"],
    target: row.target === null ? undefined : String(row.target),
    restoredTarget: row.restored_target === null ? undefined : String(row.restored_target),
    sourceHash: String(row.source_hash),
    context: JSON.parse(String(row.context_json)),
    commandCode: row.command_code === null ? undefined : Number(row.command_code),
    fieldName: row.field_name === null ? undefined : String(row.field_name)
  };
}

function rowToIssue(row: Record<string, unknown>): Issue {
  return {
    issueId: String(row.issue_id),
    severity: row.severity as Issue["severity"],
    type: String(row.type),
    engine: row.engine === null ? undefined : (row.engine as Issue["engine"]),
    file: row.file === null ? undefined : String(row.file),
    path: row.path === null ? undefined : String(row.path),
    unitId: row.unit_id === null ? undefined : String(row.unit_id),
    message: String(row.message),
    payload: row.payload_json === null ? undefined : JSON.parse(String(row.payload_json)),
    createdAt: String(row.created_at)
  };
}
