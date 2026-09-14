/**
 * 房屋级功能开放记录：按户追加 JSONL，只记 granted；revoked 仅预留形状、不写也不处理。
 * 幂等键用 JSON.stringify 三元组（不含 NUL）；读取时按记录 householdId 二次隔离并跳过坏行。
 */

import fs from "node:fs";
import path from "node:path";

export interface HouseholdFeatureGrant {
  type: "granted";
  householdId: string;
  featureId: string;
  sourceRuleDefinitionId: string;
  grantedAt: string;
}

/** 预留的撤销形状：本模块不写、也不据它撤销。 */
export interface HouseholdFeatureRevocation {
  type: "revoked";
  householdId: string;
  featureId: string;
  sourceRuleDefinitionId: string;
  revokedAt: string;
}

export type HouseholdFeatureGrantEvent = HouseholdFeatureGrant | HouseholdFeatureRevocation;

function safeFileStem(householdId: string): string {
  // 先兜非法字符，再去掉连续点，避免 ".." 出现在 basename 里
  return householdId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, "_");
}

/** 该户功能开放记录文件路径。 */
export function householdFeatureGrantsFile(dir: string, householdId: string): string {
  return path.join(dir, `${safeFileStem(householdId)}.feature.grants.jsonl`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseGrantEvent(raw: unknown): HouseholdFeatureGrant | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.type !== "granted") return null; // revoked / 未知行都跳过
  if (
    !isNonEmptyString(o.householdId) ||
    !isNonEmptyString(o.featureId) ||
    !isNonEmptyString(o.sourceRuleDefinitionId) ||
    !isNonEmptyString(o.grantedAt)
  ) {
    return null;
  }
  return {
    type: "granted",
    householdId: o.householdId,
    featureId: o.featureId,
    sourceRuleDefinitionId: o.sourceRuleDefinitionId,
    grantedAt: o.grantedAt,
  };
}

function loadGrantEvents(filePath: string): HouseholdFeatureGrant[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const events: HouseholdFeatureGrant[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const event = parseGrantEvent(parsed);
    if (event) events.push(event);
  }
  return events;
}

function grantKey(householdId: string, featureId: string, sourceRuleDefinitionId: string): string {
  return JSON.stringify([householdId, featureId, sourceRuleDefinitionId]);
}

function activeGrants(
  events: readonly HouseholdFeatureGrant[],
  householdId: string
): HouseholdFeatureGrant[] {
  const seen = new Set<string>();
  const out: HouseholdFeatureGrant[] = [];
  for (const e of events) {
    if (e.type !== "granted") continue;
    if (e.householdId !== householdId) continue;
    const key = grantKey(e.householdId, e.featureId, e.sourceRuleDefinitionId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function activeGrantsFor(dir: string, householdId: string): HouseholdFeatureGrant[] {
  return activeGrants(loadGrantEvents(householdFeatureGrantsFile(dir, householdId)), householdId);
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (!isNonEmptyString(value)) {
    throw new TypeError(`household-feature-grants: ${name} 必须是非空字符串`);
  }
  return value;
}

export interface GrantHouseholdFeatureOptions {
  dir: string;
  householdId: string;
  featureId: string;
  sourceRuleDefinitionId: string;
  grantedAt?: string;
}

export interface GrantHouseholdFeatureResult {
  grant: HouseholdFeatureGrant;
  appended: boolean;
}

export function grantHouseholdFeature(opts: GrantHouseholdFeatureOptions): GrantHouseholdFeatureResult {
  const dir = requireNonEmptyString(opts.dir, "dir");
  const householdId = requireNonEmptyString(opts.householdId, "householdId");
  const featureId = requireNonEmptyString(opts.featureId, "featureId");
  const sourceRuleDefinitionId = requireNonEmptyString(opts.sourceRuleDefinitionId, "sourceRuleDefinitionId");

  const existing = activeGrantsFor(dir, householdId).find(
    (g) => g.featureId === featureId && g.sourceRuleDefinitionId === sourceRuleDefinitionId
  );
  if (existing) return { grant: existing, appended: false };

  const grantedAt =
    opts.grantedAt === undefined
      ? new Date().toISOString()
      : requireNonEmptyString(opts.grantedAt, "grantedAt");
  const grant: HouseholdFeatureGrant = {
    type: "granted",
    householdId,
    featureId,
    sourceRuleDefinitionId,
    grantedAt,
  };
  const file = householdFeatureGrantsFile(dir, householdId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(grant)}\n`, "utf8");
  return { grant, appended: true };
}

export function hasHouseholdFeatureGrant(
  dir: string,
  householdId: string,
  featureId: string
): boolean {
  const d = requireNonEmptyString(dir, "dir");
  const h = requireNonEmptyString(householdId, "householdId");
  const f = requireNonEmptyString(featureId, "featureId");
  return activeGrantsFor(d, h).some((g) => g.featureId === f);
}

export function activeHouseholdFeatureIds(dir: string, householdId: string): string[] {
  const d = requireNonEmptyString(dir, "dir");
  const h = requireNonEmptyString(householdId, "householdId");
  return [...new Set(activeGrantsFor(d, h).map((g) => g.featureId))].sort();
}
