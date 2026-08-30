import type { JsonObject, ParsedRequest, RequestBody } from "https://raw.githubusercontent.com/adibadm409-eng/kimo-agent-chat-v4-modules/main/_shared/types.ts";
import {
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_TOP_K,
  MAX_BODY_BYTES,
  MAX_DOCUMENT_ID_LENGTH,
  MAX_SCOPE_IDS,
  MAX_SCOPE_PATH_LENGTH,
  MAX_TOP_K,
  boundedFloat,
  boundedInt,
  normalizeDocumentIds,
  text,
  unique,
} from "https://raw.githubusercontent.com/adibadm409-eng/kimo-agent-chat-v4-modules/main/_shared/utils.ts";
import { corsHeaders, errorResponse, json, verifyUser } from "https://raw.githubusercontent.com/adibadm409-eng/kimo-agent-chat-v4-modules/main/_shared/http.ts";
import { applyAiAnalysis, buildQueryAnalysis, canSkipAiAnalysis, deterministicAiAnalysis, improveQueryWithAi, shouldUseAiAnalysis } from "https://raw.githubusercontent.com/adibadm409-eng/kimo-agent-chat-v4-modules/main/_shared/query-analysis.ts";
import { applyAutoSourceScope, invokeSourceDiscovery } from "https://raw.githubusercontent.com/adibadm409-eng/kimo-agent-chat-v4-modules/main/_shared/source-discovery.ts";
import { evidenceScopeValidation, selectGroundingResults, synthesizeGroundedAnswer } from "https://raw.githubusercontent.com/adibadm409-eng/kimo-agent-chat-v4-modules/main/_shared/answer-synthesis.ts";
import { articleRetrievalDiagnostic, sanitizeCandidate } from "https://raw.githubusercontent.com/adibadm409-eng/kimo-agent-chat-v4-modules/main/_shared/candidates.ts";
import { runOrchestration } from "https://raw.githubusercontent.com/adibadm409-eng/kimo-agent-chat-v4-modules/main/_shared/orchestration.ts";
import { expandRelatedEvidence, summarizeQuality, verifyAndSearch } from "https://raw.githubusercontent.com/adibadm409-eng/kimo-agent-chat-v4-modules/main/_shared/search.ts";

function validateQuery(value: unknown) {
  const query = text(value, 800);
  if (!query || /^(?:[\p{P}\p{S}\s])+$/u.test(query)) return null;
  return query;
}

function parseRequest(body: RequestBody): ParsedRequest {
  const query = validateQuery(body.query) ?? validateQuery(body.question);
  if (!query) throw new Error("INVALID_QUERY");
  if (body.mode !== undefined && body.mode !== "hybrid") throw new Error("HYBRID_SEARCH_REQUIRED");
  const topK = boundedInt(body.topK, DEFAULT_TOP_K, 1, MAX_TOP_K);
  const matchThreshold = boundedFloat(body.matchThreshold, DEFAULT_MATCH_THRESHOLD, 0.2, 0.95);
  const documentIds = normalizeDocumentIds(body.documentIds);
  const versionIds = normalizeDocumentIds(body.versionIds, MAX_SCOPE_IDS, 80);
  const unitIds = normalizeDocumentIds(body.unitIds, MAX_SCOPE_IDS, 240);
  const sectionPaths = normalizeDocumentIds(body.sectionPaths, MAX_SCOPE_IDS, MAX_SCOPE_PATH_LENGTH);
  const retrievalScope = body.retrievalScope === "narrow" ? "narrow" : body.retrievalScope === "normal" ? "normal" : "wide";
  const rawComparison = body.comparison && typeof body.comparison === "object" && !Array.isArray(body.comparison) ? body.comparison as JsonObject : {};
  const comparison: ParsedRequest["comparison"] = {
    enabled: rawComparison.enabled !== false,
    answerMode: rawComparison.answerMode === "single_cluster" ? "single_cluster" : "multi_source",
    maxSources: boundedInt(rawComparison.maxSources, 4, 2, 6),
    maxResultsPerSource: boundedInt(rawComparison.maxResultsPerSource, 3, 1, 5),
  };
  const rawOrchestration = body.orchestration && typeof body.orchestration === "object" && !Array.isArray(body.orchestration) ? body.orchestration as JsonObject : {};
  const orchestration: ParsedRequest["orchestration"] = {
    enabled: rawOrchestration.enabled !== false,
    mode: rawOrchestration.mode === "parallel_research" || rawOrchestration.mode === "adaptive" || rawOrchestration.mode === "single" ? rawOrchestration.mode : "deep_review",
    maxWorkers: boundedInt(rawOrchestration.maxWorkers, 3, 1, 3),
    timeoutMs: boundedInt(rawOrchestration.timeoutMs, 45_000, 10_000, 60_000),
  };
  const rawSkill = body.searchSkill && typeof body.searchSkill === "object" && !Array.isArray(body.searchSkill) ? body.searchSkill as JsonObject : {};
  const searchSkill: ParsedRequest["searchSkill"] = {
    enabled: rawSkill.enabled !== false,
    profileKey: text(rawSkill.profileKey, 120) || null,
    profileOwner: text(rawSkill.profileOwner, 120) || "kimo-lawyer-agent",
  };
  const rawDiscovery = body.sourceDiscovery && typeof body.sourceDiscovery === "object" && !Array.isArray(body.sourceDiscovery) ? body.sourceDiscovery as JsonObject : {};
  const sourceDiscovery: ParsedRequest["sourceDiscovery"] = {
    enabled: rawDiscovery.enabled !== false,
    mode: rawDiscovery.mode === "route_then_retrieve" ? "route_then_retrieve" : "parallel",
    reviewMode: rawDiscovery.reviewMode === "ai" || rawDiscovery.reviewMode === "none" ? rawDiscovery.reviewMode : "heuristic",
    outputMode: rawDiscovery.outputMode === "source_map" || rawDiscovery.outputMode === "compact" ? rawDiscovery.outputMode : "routing",
    maxSources: boundedInt(rawDiscovery.maxSources, 6, 1, 10),
    autoScope: rawDiscovery.autoScope === true,
  };
  return {
    query,
    topK,
    matchThreshold,
    jurisdictionCode: text(body.jurisdictionCode, 32) || null,
    instrumentType: text(body.instrumentType, 40) || null,
    legalDomain: text(body.legalDomain, 120) || null,
    documentIds,
    versionIds,
    unitIds,
    sectionPaths,
    retrievalScope,
    includeRelated: body.includeRelated !== false,
    comparison,
    orchestration,
    searchSkill,
    sourceDiscovery,
    idempotencyKey: text(body.idempotencyKey, 160) || crypto.randomUUID(),
    analysisMode: body.analysisMode === "fast" || body.analysisMode === "auto" ? body.analysisMode : "deep",
  };
}

async function consumeAgentUsage(service: any, userId: string, idempotencyKey: string) {
  const { data, error } = await service.rpc("consume_usage_limit_v2", {
    p_user_id: userId,
    p_scope_key: "ai_request",
    p_idempotency_key: `kimo-lawyer-agent:${idempotencyKey}`,
  });
  const row = Array.isArray(data) ? data[0] as JsonObject | undefined : undefined;
  if (error || !row) throw new Error("USAGE_UNAVAILABLE");
  const outcome = text(row.outcome, 80);
  if (outcome === "consumed" || outcome === "already_counted") return row;
  if (outcome === "daily_limit_reached" || outcome === "minute_limit_reached") throw new Error(outcome.toUpperCase());
  throw new Error(outcome.toUpperCase() || "USAGE_UNAVAILABLE");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return errorResponse(request, "METHOD_NOT_ALLOWED", 405);

  let access: Awaited<ReturnType<typeof verifyUser>>;
  try {
    access = await verifyUser(request);
  } catch (error) {
    console.error("kimo-lawyer-agent configuration error", error instanceof Error ? error.message : "UNKNOWN");
    return errorResponse(request, "SERVICE_CONFIGURATION_ERROR", 503);
  }
  if (!access) return errorResponse(request, "UNAUTHENTICATED", 401);

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return errorResponse(request, "REQUEST_TOO_LARGE", 413);
  const rawBody = await request.text().catch(() => "");
  if (!rawBody || new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return errorResponse(request, "REQUEST_TOO_LARGE", 413);

  let body: RequestBody;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return errorResponse(request, "INVALID_REQUEST_BODY", 400);
    body = parsed as RequestBody;
  } catch {
    return errorResponse(request, "INVALID_REQUEST_BODY", 400);
  }

  let input: ParsedRequest;
  try {
    input = parseRequest(body);
  } catch (error) {
    const code = error instanceof Error ? error.message : "INVALID_QUERY";
    return errorResponse(request, code, 400);
  }

  const baselineAnalysis = buildQueryAnalysis(input.query, {
    jurisdictionCode: input.jurisdictionCode,
    instrumentType: input.instrumentType,
    legalDomain: input.legalDomain,
  });
  const startedAt = Date.now();
  try {
    await consumeAgentUsage(access.service, access.userId, input.idempotencyKey);
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 80).toUpperCase() : "USAGE_UNAVAILABLE";
    return errorResponse(request, code, code.includes("LIMIT") ? 429 : 503);
  }

  try {
    // مسار سريع: تخطي تحليل AI حين يكفي التحليل الحتمي (كلمات واضحة بلا أرقام مواد) — حتى في deep
    const clearQuery = canSkipAiAnalysis(baselineAnalysis) && baselineAnalysis.articleNumbers.length === 0;\n    const useAiAnalysis = clearQuery ? false : shouldUseAiAnalysis(input, baselineAnalysis);
    const improved = useAiAnalysis
      ? await improveQueryWithAi(access.service, input, baselineAnalysis)
      : { analysis: deterministicAiAnalysis(baselineAnalysis), model: null };
    const analysis = applyAiAnalysis(baselineAnalysis, improved.analysis);
    let sourceDiscovery: JsonObject | null = null;
    let effectiveInput = input;
    let outcome: Awaited<ReturnType<typeof verifyAndSearch>>;
    const sourceDiscoveryPromise = input.sourceDiscovery.enabled ? invokeSourceDiscovery(request, input) : Promise.resolve(null);
    if (input.sourceDiscovery.enabled && input.sourceDiscovery.mode === "route_then_retrieve") {
      sourceDiscovery = await sourceDiscoveryPromise;
      const routed = applyAutoSourceScope(input, sourceDiscovery);
      effectiveInput = routed.input;
      if (routed.applied) sourceDiscovery = { ...sourceDiscovery, autoScopeApplied: true };
      outcome = await verifyAndSearch(access.service, analysis, effectiveInput);
      if (routed.applied && outcome.final.selected.length === 0) {
        outcome = await verifyAndSearch(access.service, analysis, input);
        effectiveInput = input;
        sourceDiscovery = { ...(sourceDiscovery ?? {}), autoScopeFallback: true, autoScopeFallbackReason: "NO_SCOPED_RESULTS" };
      }
    } else {
      const [discoveryResult, parallelOutcome] = await Promise.all([
        sourceDiscoveryPromise,
        verifyAndSearch(access.service, analysis, input),
      ]);
      sourceDiscovery = discoveryResult;
      outcome = parallelOutcome;
    }
    const quality = summarizeQuality(outcome.final, outcome.attempts, analysis);
    const requestId = request.headers.get("x-request-id")?.trim().slice(0, 120) || crypto.randomUUID();
    const retrievedResults = outcome.final.selected.map((candidate) => sanitizeCandidate(candidate, analysis));
    const results = selectGroundingResults(retrievedResults, effectiveInput.comparison);
    const topScopeResults = results.slice(0, 5);
    const scopeHints = {
      documentIds: unique(topScopeResults.map((row) => text(row.documentId, MAX_DOCUMENT_ID_LENGTH))).slice(0, MAX_SCOPE_IDS),
      versionIds: unique(topScopeResults.map((row) => text(row.versionId, 80))).slice(0, MAX_SCOPE_IDS),
      unitIds: unique(topScopeResults.map((row) => text(row.unitId, 240))).slice(0, MAX_SCOPE_IDS),
      sectionPaths: unique(topScopeResults.map((row) => text(row.sectionPath, MAX_SCOPE_PATH_LENGTH))).slice(0, MAX_SCOPE_IDS),
      suggestedScope: topScopeResults.length ? "narrow" : "wide",
      source: "validated_top_results",
    };
    // العمال أولاً (نتائجهم تدخل سياق الصياغة لرفع جودة claims) ثم الصياغة بالتوازي مع توسيع العلاقات
    const orchestration = await runOrchestration(access.service, input.query, analysis, results, quality, effectiveInput);
    const [grounded, relatedEvidence] = await Promise.all([
      synthesizeGroundedAnswer(access.service, input.query, analysis, results, quality, effectiveInput, orchestration),
      input.includeRelated ? expandRelatedEvidence(access.service, results, input) : Promise.resolve({ edges: [], sources: [], attempted: false, skipped: true }),
    ]);
    if (orchestration && orchestration.arbitration.status !== "convergent") {
      grounded.answer.confidence = "low";
      grounded.answer.caveats = [...grounded.answer.caveats, "لم تتقارب إشارات العمال الفرعيين بصورة كافية؛ راجع الأدلة الأصلية قبل اعتماد النتيجة."];
    }
    const articleTargeting = articleRetrievalDiagnostic(analysis, results, outcome.attempts, effectiveInput);
    const attempts = outcome.attempts.map((attempt) => ({
      pass: attempt.pass,
      label: attempt.label,
      mode: attempt.mode,
      queryLength: attempt.query.length,
      resultCount: attempt.result?.results.length ?? 0,
      error: attempt.error,
      latencyMs: attempt.latencyMs,
    }));

    return json(request, {
      requestId,
      query: input.query,
      retrieval: {
        scope: effectiveInput.retrievalScope,
        requestedFilters: {
          documentIds: effectiveInput.documentIds,
          versionIds: effectiveInput.versionIds,
          unitIds: effectiveInput.unitIds,
          sectionPaths: effectiveInput.sectionPaths,
          includeRelated: effectiveInput.includeRelated,
          searchSkill: effectiveInput.searchSkill,
          analysisMode: effectiveInput.analysisMode,
          orchestration: effectiveInput.orchestration,
          sourceDiscovery: effectiveInput.sourceDiscovery,
          comparison: effectiveInput.comparison,
        },
        identifiersAvailable: ["documentId", "versionId", "chunkId", "unitId", "partId", "chapterId", "articleNumber", "sectionPath"],
        hierarchyNote: "partId وchapterId غير موجودين كأعمدة مستقلة في المخطط الحالي؛ partLabel/chapterLabel وpartRef/chapterRef مشتقة من sectionPath، بينما documentId/versionId/chunkId/unitId معرفات قاعدة بيانات مثبتة.",
        tools: ["lexical_text", "semantic_vector", "hybrid_rrf", "adaptive_retry", "relation_expansion", "bounded_parallel_research_workers", "central_arbitration", "professional_narrative_rebuild"],
        searchProfile: outcome.attempts.find((attempt) => attempt.result?.profile)?.result?.profile ?? null,
        scopeValidation: evidenceScopeValidation(results, effectiveInput),
        groundingSelection: { initialCandidateCount: retrievedResults.length, selectedEvidenceCount: results.length, selectedDocumentIds: unique(results.map((row) => text(row.documentId, MAX_DOCUMENT_ID_LENGTH))).slice(0, MAX_SCOPE_IDS), selectedVersionIds: unique(results.map((row) => text(row.versionId, 80))).slice(0, MAX_SCOPE_IDS), policy: effectiveInput.comparison.enabled && effectiveInput.comparison.answerMode === "multi_source" ? "multi_source_comparison_with_bounded_clusters" : "single_document_version_cluster_for_answer", comparison: effectiveInput.comparison },
        scopeHints,
        articleTargeting,
        orchestration,
        relatedEvidence,
        sourceDiscovery,
      },
      analysis: {
        analysisMode: input.analysisMode,
        orchestrationMode: input.orchestration.mode,
        aiEnhanced: improved.model !== null,
        aiModel: improved.model,
        normalizedQuery: analysis.normalized,
        canonicalQuery: analysis.canonicalQuery,
        keywordQuery: analysis.keywordQuery,
        semanticQuery: analysis.semanticQuery,
        alternativeQuery: analysis.alternativeQuery,
        intent: analysis.intent,
        intentTerms: analysis.intentTerms,
        keywords: analysis.keywords,
        articleNumbers: analysis.articleNumbers,
        years: analysis.years,
        entities: analysis.entities,
      },
      answer: grounded.answer,
      answerGrounding: grounded.answer.answerGrounding,
      search: {
        mode: "hybrid",
        model: { key: "supabase/gte-small", version: "gte-small-v1", dimensions: 384 },
        filters: {
          jurisdictionCode: input.jurisdictionCode,
          instrumentType: input.instrumentType,
          legalDomain: input.legalDomain,
          documentCount: input.documentIds?.length ?? 0,
          versionCount: input.versionIds?.length ?? 0,
          unitCount: input.unitIds?.length ?? 0,
          sectionPathCount: input.sectionPaths?.length ?? 0,
          activeOnly: true,
        },
        quality: {
          ...quality,
          latencyMs: Date.now() - startedAt,
        },
        attempts,
        comparison: outcome.final.comparison,
        evidenceStatus: quality.evidenceStatus,
        answerGrounding: grounded.answer.answerGrounding,
        articleTargeting,
      },
      aiAnswer: grounded.model,
      results,
      guidance: quality.evidenceStatus === "insufficient"
        ? "لم تُسترجع أدلة قانونية كافية بعد التصفية والمقارنة. لا تُنشئ استنتاجاً قانونياً جازماً اعتماداً على هذه النتيجة."
        : quality.evidenceStatus === "weak"
          ? "الأدلة مفيدة مبدئياً لكنها ضعيفة أو غير متفق عليها بين المسارات. أعد التحقق من النص الكامل والاختصاص والنسخة النافذة."
          : "النتائج اجتازت المقارنة بين مسارات البحث، ومع ذلك يجب التحقق من النص الكامل والاختصاص والنسخة النافذة قبل الاستنتاج النهائي.",
    });
  } catch (error) {
    console.error("kimo-lawyer-agent retrieval error", {
      code: error instanceof Error ? error.message : "RETRIEVAL_FAILED",
      queryLength: input.query.length,
      intent: baselineAnalysis.intent,
      userId: access.userId,
    });
    return errorResponse(request, "LEGAL_RETRIEVAL_UNAVAILABLE", 503);
  }
});