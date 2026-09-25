import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CodecDefinition, CostMetrics, ModelFingerprint, OptimizationScope,
  TaskClass, UsageMetrics,
} from "@semantic-ir/core";
import { CodecDefinitionSchema } from "./codec.js";

export interface StoredProfile {
  readonly provider: string;
  readonly model: string;
  readonly taskClass: TaskClass;
  readonly fingerprintSha256: string;
  readonly codecId: string;
  readonly status: "stable" | "needs_reverification";
  readonly calibratedAt: string;
}

export interface MetricEvent {
  readonly requestId: string;
  readonly scope: OptimizationScope;
  readonly model: string;
  readonly taskClass: TaskClass;
  readonly codecId: string | null;
  readonly fallbackReason: string | null;
  readonly usage: UsageMetrics;
  readonly cost: CostMetrics | null;
  readonly latencyMs: number;
}

export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS codecs (
        id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        provider TEXT NOT NULL, model TEXT NOT NULL, task_class TEXT NOT NULL,
        fingerprint_sha256 TEXT NOT NULL, codec_id TEXT NOT NULL,
        status TEXT NOT NULL, calibrated_at TEXT NOT NULL,
        PRIMARY KEY (provider, model, task_class)
      );
      CREATE TABLE IF NOT EXISTS profile_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, model TEXT NOT NULL,
        task_class TEXT NOT NULL, codec_id TEXT NOT NULL, event TEXT NOT NULL,
        occurred_at TEXT NOT NULL, fingerprint_sha256 TEXT
      );
      CREATE TABLE IF NOT EXISTS metrics (
        request_id TEXT PRIMARY KEY, scope TEXT NOT NULL, model TEXT NOT NULL,
        task_class TEXT NOT NULL, codec_id TEXT, fallback_reason TEXT,
        usage_json TEXT NOT NULL, cost_json TEXT, latency_ms INTEGER NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    `);
    const historyColumns = this.db.prepare("PRAGMA table_info(profile_history)").all() as
      Array<{ name: string }>;
    if (!historyColumns.some((column) => column.name === "fingerprint_sha256")) {
      this.db.exec("ALTER TABLE profile_history ADD COLUMN fingerprint_sha256 TEXT");
    }
  }

  close(): void { this.db.close(); }

  saveCodec(codec: CodecDefinition, status: "candidate" | "stable" | "rejected"): void {
    const parsed = CodecDefinitionSchema.parse(codec);
    this.db.prepare("INSERT OR REPLACE INTO codecs(id, definition_json, status) VALUES (?, ?, ?)")
      .run(parsed.id, JSON.stringify(parsed), status);
  }

  getCodec(id: string): CodecDefinition | null {
    const row = this.db.prepare("SELECT definition_json FROM codecs WHERE id=?").get(id) as
      { definition_json: string } | undefined;
    return row ? CodecDefinitionSchema.parse(JSON.parse(row.definition_json)) as CodecDefinition : null;
  }

  listCodecs(): Array<{ id: string; status: string }> {
    return this.db.prepare("SELECT id, status FROM codecs ORDER BY id").all() as
      Array<{ id: string; status: string }>;
  }

  getProfile(provider: string, model: string, taskClass: TaskClass): StoredProfile | null {
    const row = this.db.prepare(`
      SELECT provider, model, task_class, fingerprint_sha256, codec_id, status, calibrated_at
      FROM profiles WHERE provider=? AND model=? AND task_class=?
    `).get(provider, model, taskClass) as Record<string, string> | undefined;
    return row ? {
      provider: row.provider ?? provider, model: row.model ?? model,
      taskClass, fingerprintSha256: row.fingerprint_sha256 ?? "",
      codecId: row.codec_id ?? "", status: row.status as StoredProfile["status"],
      calibratedAt: row.calibrated_at ?? "",
    } : null;
  }

  listProfiles(): StoredProfile[] {
    const rows = this.db.prepare("SELECT * FROM profiles ORDER BY provider, model, task_class").all() as
      Array<Record<string, string>>;
    return rows.map((row) => ({
      provider: row.provider ?? "", model: row.model ?? "",
      taskClass: (row.task_class ?? "unknown") as TaskClass,
      fingerprintSha256: row.fingerprint_sha256 ?? "", codecId: row.codec_id ?? "",
      status: (row.status ?? "needs_reverification") as StoredProfile["status"],
      calibratedAt: row.calibrated_at ?? "",
    }));
  }

  promote(fingerprint: ModelFingerprint, taskClass: TaskClass, codec: CodecDefinition): void {
    CodecDefinitionSchema.parse(codec);
    this.db.exec("BEGIN");
    try {
      this.saveCodec(codec, "stable");
      this.db.prepare(`
        INSERT INTO profiles(provider,model,task_class,fingerprint_sha256,codec_id,status,calibrated_at)
        VALUES(?,?,?,?,?,'stable',?)
        ON CONFLICT(provider,model,task_class) DO UPDATE SET
          fingerprint_sha256=excluded.fingerprint_sha256, codec_id=excluded.codec_id,
          status='stable', calibrated_at=excluded.calibrated_at
      `).run(fingerprint.provider, fingerprint.model, taskClass,
        fingerprint.fingerprintSha256, codec.id, new Date().toISOString());
      this.db.prepare(`
        INSERT INTO profile_history(provider,model,task_class,codec_id,event,occurred_at,fingerprint_sha256)
        VALUES(?,?,?,?,'promote',?,?)
      `).run(fingerprint.provider, fingerprint.model, taskClass, codec.id,
        new Date().toISOString(), fingerprint.fingerprintSha256);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markDrift(provider: string, model: string, taskClass: TaskClass): void {
    this.db.prepare(`
      UPDATE profiles SET status='needs_reverification'
      WHERE provider=? AND model=? AND task_class=?
    `).run(provider, model, taskClass);
  }

  rollback(provider: string, model: string, taskClass: TaskClass): string | null {
    const profile = this.getProfile(provider, model, taskClass);
    if (!profile || profile.status !== "stable") return null;
    const history = this.db.prepare(`
      SELECT codec_id, fingerprint_sha256 FROM profile_history
      WHERE provider=? AND model=? AND task_class=? AND event='promote'
      ORDER BY id DESC LIMIT 2
    `).all(provider, model, taskClass) as Array<{
      codec_id: string; fingerprint_sha256: string | null;
    }>;
    const prior = history[1];
    if (!prior || prior.fingerprint_sha256 !== profile.fingerprintSha256) return null;
    this.db.prepare(`
      UPDATE profiles SET codec_id=?, status='stable', calibrated_at=?
      WHERE provider=? AND model=? AND task_class=?
    `).run(prior.codec_id, new Date().toISOString(), provider, model, taskClass);
    this.db.prepare(`
      INSERT INTO profile_history(provider,model,task_class,codec_id,event,occurred_at,fingerprint_sha256)
      VALUES(?,?,?,?,'rollback',?,?)
    `).run(provider, model, taskClass, prior.codec_id,
      new Date().toISOString(), profile.fingerprintSha256);
    return prior.codec_id;
  }

  recordMetric(event: MetricEvent): void {
    this.db.prepare(`
      INSERT INTO metrics(request_id,scope,model,task_class,codec_id,fallback_reason,
        usage_json,cost_json,latency_ms,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(event.requestId, event.scope, event.model, event.taskClass,
      event.codecId, event.fallbackReason, JSON.stringify(event.usage),
      event.cost ? JSON.stringify(event.cost) : null, event.latencyMs, new Date().toISOString());
  }

  metricsSummary(): {
    requests: number; fallbacks: number; byScope: Array<{ scope: string; requests: number }>;
  } {
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS requests, SUM(CASE WHEN fallback_reason IS NOT NULL THEN 1 ELSE 0 END) AS fallbacks FROM metrics
    `).get() as { requests: number; fallbacks: number | null };
    const byScope = this.db.prepare(`
      SELECT scope, COUNT(*) AS requests FROM metrics GROUP BY scope ORDER BY scope
    `).all() as Array<{ scope: string; requests: number }>;
    return { requests: totals.requests, fallbacks: totals.fallbacks ?? 0, byScope };
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO settings(key,value_json) VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key=?").get(key) as
      { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : null;
  }
}
