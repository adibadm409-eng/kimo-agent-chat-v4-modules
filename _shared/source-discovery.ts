import type { JsonObject, ParsedRequest } from "./types.ts";
import { MAX_DOCUMENT_ID_LENGTH, MAX_SCOPE_IDS, finiteNumber, safeStringList } from "./utils.ts";

export async function invokeSourceDiscovery(request: Request, input: ParsedRequest) {
  if (!input.sourceDiscovery.enabled) return null;
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authorization = request.headers.get("Authorization");
  if (!supabaseUrl || !anonKey || !authorization) return { error: "SOURCE_DISCOVERY_CONFIGURATION_MISSING" };
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/kimo-legal-source-map`, {
      method: "POST",
      headers: { Authorization: authorization, apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: input.query,
        topK: input.sourceDiscovery.maxSources,
        matchThreshold: input.matchThreshold,
        jurisdictionCode: input.jurisdictionCode,
        instrumentType: input.instrumentType,
        legalDomain: input.legalDomain,
        documentIds: input.documentIds,
        versionIds: input.versionIds,
        unitIds: input.unitIds,
        sectionPaths: input.sectionPaths,
        retrievalScope: input.retrievalScope,
        control: {
          outputMode: input.sourceDiscovery.outputMode,
          detailLevel: input.sourceDiscovery.outputMode === "routing" ? "standard" : "compact",
          reviewMode: input.sourceDiscovery.reviewMode,
          maxSources: input.sourceDiscovery.maxSources,
          includeHierarchy: input.sourceDiscovery.outputMode !== "compact",
          includeModeCoverage: input.sourceDiscovery.outputMode !== "compact",
          includeDiagnostics: false,
        },
        searchSkill: {
          enabled: input.searchSkill.enabled,
          profileKey: input.searchSkill.profileKey,
          profileOwner: input.searchSkill.profileOwner,
        },
        idempotencyKey: `${input.idempotencyKey}:source-discovery`,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await response.json().catch(() => null) as JsonObject | null;
    if (!response.ok || !body) return { error: `SOURCE_DISCOVERY_HTTP_${response.status}` };
    return body.sourceDiscovery && typeof body.sourceDiscovery === "object" ? body.sourceDiscovery as JsonObject : { error: "SOURCE_DISCOVERY_INVALID_RESPONSE" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "SOURCE_DISCOVERY_FAILED" };
  }
}

export function applyAutoSourceScope(input: ParsedRequest, sourceDiscovery: JsonObject | null) {
  if (!sourceDiscovery || !input.sourceDiscovery.autoScope || input.sourceDiscovery.mode !== "route_then_retrieve") return { input, applied: false };
  const candidates = Array.isArray(sourceDiscovery.routingCandidates) ? sourceDiscovery.routingCandidates : [];
  const first = candidates[0] && typeof candidates[0] === "object" && !Array.isArray(candidates[0]) ? candidates[0] as JsonObject : null;
  const sourceRank = finiteNumber(first?.sourceRank) ?? 0;
  const misleadingRisk = finiteNumber(first?.misleadingRisk) ?? 1;
  const filters = first?.recommendedFilters && typeof first.recommendedFilters === "object" && !Array.isArray(first.recommendedFilters) ? first.recommendedFilters as JsonObject : {};
  if (!first || sourceRank < 0.55 || misleadingRisk > 0.55) return { input, applied: false };
  const routedInput = {
    ...input,
    documentIds: input.documentIds ?? safeStringList(filters.documentIds, MAX_DOCUMENT_ID_LENGTH, MAX_SCOPE_IDS),
    versionIds: input.versionIds ?? safeStringList(filters.versionIds, 80, MAX_SCOPE_IDS),
    unitIds: input.unitIds,
    sectionPaths: input.sectionPaths,
    retrievalScope: "narrow" as const,
  };
  return { input: routedInput, applied: true };
}