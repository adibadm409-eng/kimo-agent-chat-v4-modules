import { generateLegalKnowledgeEmbedding, searchLegalKnowledge, fuseHybridResults } from "./legal-knowledge-search.ts";
import type { JsonObject, ParsedRequest, QueryAnalysis, SearchAttempt } from "./types.ts";
import { MAX_DOCUMENT_ID_LENGTH, MAX_QUERY_LENGTH, MAX_SEARCH_PASSES, SEARCH_MATCH_COUNT, unique, text } from "./utils.ts";
import { applyScopeFilter, articleMatch, enrichResultIdentity, keywordCoverage, qualityScore, rerankAndCompare, matchesScope } from "./candidates.ts";
import type { QualitySummary } from "./answer-synthesis.ts";

export async function verifyAndSearch(
  service: any,
  analysis: QueryAnalysis,
  input: ParsedRequest,
) {
  const attempts: SearchAttempt[] = [];
  const searchMatchCount = input.retrievalScope === "wide" ? 50 : input.retrievalScope === "narrow" ? 12 : SEARCH_MATCH_COUNT;
  const embeddingCache = new Map<string, Promise<number[]>>();
  const identityCache = new Map<string, JsonObject>();
  const getEmbedding = (query: string) => {
    const cached = embeddingCache.get(query);
    if (cached) return cached;
    const promise = generateLegalKnowledgeEmbedding(query);
    embeddingCache.set(query, promise);
    return promise;
  };

  const runTriplet = async (pass: number, label: string, querySet: { text: string; vector: string; hybrid: string }) => {
    const runText = (async () => {
      const queryStartedAt = Date.now();
      try {
        const result = await searchLegalKnowledge(service, {
          query: querySet.text,
          mode: "text",
          matchCount: searchMatchCount,
          matchThreshold: input.matchThreshold,
          jurisdictionCode: input.jurisdictionCode,
          instrumentType: input.instrumentType,
          legalDomain: input.legalDomain,
          documentIds: input.documentIds,
          includeNonActive: false,
          idempotencyKey: input.idempotencyKey,
          queryEmbedding: null,
          profileKey: input.searchSkill.enabled ? input.searchSkill.profileKey : null,
          profileOwner: input.searchSkill.enabled ? input.searchSkill.profileOwner : null,
        });
        return { pass, label, query: querySet.text, mode: "text", result, error: null, latencyMs: Date.now() - queryStartedAt } as SearchAttempt;
      } catch (error) {
        return { pass, label, query: querySet.text, mode: "text", result: null, error: error instanceof Error ? error.message : "TEXT_SEARCH_FAILED", latencyMs: Date.now() - queryStartedAt } as SearchAttempt;
      }
    })();
    let embedding: number[] | null = null;
    let embeddingError: string | null = null;
    try {
      embedding = await getEmbedding(querySet.vector);
    } catch (error) {
      embeddingError = error instanceof Error ? error.message : "EMBEDDING_FAILED";
    }
    const runVector = (async () => {
      const queryStartedAt = Date.now();
      if (!embedding) return { pass, label, query: querySet.vector, mode: "vector", result: null, error: embeddingError ?? "EMBEDDING_FAILED", latencyMs: Date.now() - queryStartedAt } as SearchAttempt;
      try {
        const result = await searchLegalKnowledge(service, {
          query: querySet.vector,
          mode: "vector",
          matchCount: searchMatchCount,
          matchThreshold: input.matchThreshold,
          jurisdictionCode: input.jurisdictionCode,
          instrumentType: input.instrumentType,
          legalDomain: input.legalDomain,
          documentIds: input.documentIds,
          includeNonActive: false,
          idempotencyKey: input.idempotencyKey,
          queryEmbedding: embedding,
          profileKey: input.searchSkill.enabled ? input.searchSkill.profileKey : null,
          profileOwner: input.searchSkill.enabled ? input.searchSkill.profileOwner : null,
        });
        return { pass, label, query: querySet.vector, mode: "vector", result, error: null, latencyMs: Date.now() - queryStartedAt } as SearchAttempt;
      } catch (error) {
        return { pass, label, query: querySet.vector, mode: "vector", result: null, error: error instanceof Error ? error.message : "VECTOR_SEARCH_FAILED", latencyMs: Date.now() - queryStartedAt } as SearchAttempt;
      }
    })();
    const settled = await Promise.all([runText, runVector]);
    const textAttempt = settled.find((attempt) => attempt.mode === "text");
    const vectorAttempt = settled.find((attempt) => attempt.mode === "vector");
    const enrichedRows = await enrichResultIdentity(service, [
      ...(textAttempt?.result?.results ?? []),
      ...(vectorAttempt?.result?.results ?? []),
    ], identityCache);
    const enrichedByChunk = new Map(enrichedRows.map((row) => [text(row.chunk_id, 240), row]));
    const scopedTextRows = applyScopeFilter((textAttempt?.result?.results ?? []).map((row) => enrichedByChunk.get(text(row.chunk_id, 240)) ?? row), input);
    const scopedVectorRows = applyScopeFilter((vectorAttempt?.result?.results ?? []).map((row) => enrichedByChunk.get(text(row.chunk_id, 240)) ?? row), input);
    const scopedSettled = settled.map((attempt) => attempt.mode === "text"
      ? { ...attempt, result: attempt.result ? { ...attempt.result, results: scopedTextRows } : null }
      : attempt.mode === "vector"
        ? { ...attempt, result: attempt.result ? { ...attempt.result, results: scopedVectorRows } : null }
        : attempt);
    attempts.push(...scopedSettled);
    const scopedTextAttempt = scopedSettled.find((attempt) => attempt.mode === "text");
    const scopedVectorAttempt = scopedSettled.find((attempt) => attempt.mode === "vector");
    const hybridRows = fuseHybridResults(
      scopedTextAttempt?.result?.results ?? [],
      scopedVectorAttempt?.result?.results ?? [],
      searchMatchCount,
    );
    attempts.push({
      pass,
      label,
      query: querySet.hybrid,
      mode: "hybrid",
      result: {
        mode: "hybrid",
        model: scopedVectorAttempt?.result?.model ?? null,
        results: hybridRows,
        queryLength: querySet.hybrid.length,
      },
      error: scopedTextAttempt?.error || scopedVectorAttempt?.error || null,
      latencyMs: Math.max(scopedTextAttempt?.latencyMs ?? 0, scopedVectorAttempt?.latencyMs ?? 0),
    });
  };

  await runTriplet(1, "original", {
    text: analysis.keywordQuery,
    vector: analysis.semanticQuery,
    hybrid: analysis.canonicalQuery,
  });

  const preliminary = rerankAndCompare(attempts, analysis, input.topK);
  const needsRetry = preliminary.selected.length < Math.min(input.topK, 3) || preliminary.candidateCount < 3 || !preliminary.selected.some((candidate) => candidate.modes.size >= 2);
  const needsArticlePass = analysis.articleNumbers.length > 0 && !preliminary.selected.some((candidate) => articleMatch(candidate, analysis) > 0);
  if (MAX_SEARCH_PASSES > 1 && (needsArticlePass || (needsRetry && analysis.alternativeQuery !== analysis.canonicalQuery))) {
    if (needsArticlePass) {
      const articleQuery = analysis.articleNumbers.map((number) => `مادة ${number}`).join(" ");
      await runTriplet(2, "article_targeted", {
        text: `${articleQuery} ${analysis.canonicalQuery}`.slice(0, MAX_QUERY_LENGTH),
        vector: `${articleQuery} ${analysis.semanticQuery}`.slice(0, MAX_QUERY_LENGTH),
        hybrid: `${articleQuery} ${analysis.canonicalQuery}`.slice(0, MAX_QUERY_LENGTH),
      });
    } else {
      await runTriplet(2, "reformulated", {
        text: analysis.alternativeQuery,
        vector: `${analysis.alternativeQuery} النية ${analysis.intent}`.slice(0, MAX_QUERY_LENGTH),
        hybrid: analysis.alternativeQuery,
      });
    }
  }

  return { attempts, final: rerankAndCompare(attempts, analysis, input.topK), needsRetry };
}

export async function expandRelatedEvidence(service: any, results: JsonObject[], input: ParsedRequest) {
  const seedChunkIds = unique(results.slice(0, 5).map((row) => text(row.chunkId, 240)).filter(Boolean));
  if (!seedChunkIds.length) return { edges: [], sources: [], attempted: false };
  const fields = "id,relation_type,from_document_id,to_document_id,from_chunk_id,to_chunk_id,relation_scope,confidence,basis,citation_label";
  const [fromResponse, toResponse] = await Promise.all([
    service.from("legal_knowledge_relations").select(fields).in("from_chunk_id", seedChunkIds).gte("confidence", 0.65).limit(40),
    service.from("legal_knowledge_relations").select(fields).in("to_chunk_id", seedChunkIds).gte("confidence", 0.65).limit(40),
  ]);
  if (fromResponse.error && toResponse.error) return { edges: [], sources: [], attempted: true, error: "RELATION_EXPANSION_FAILED" };
  const edges = [...(fromResponse.data ?? []), ...(toResponse.data ?? [])] as JsonObject[];
  const edgeKeys = new Set<string>();
  const uniqueEdges = edges.filter((edge) => {
    const key = `${text(edge.id, 80)}|${text(edge.from_chunk_id, 240)}|${text(edge.to_chunk_id, 240)}|${text(edge.relation_type, 80)}`;
    if (edgeKeys.has(key)) return false;
    edgeKeys.add(key);
    return true;
  }).slice(0, 60);
  const relatedChunkIds = unique(uniqueEdges.flatMap((edge) => [text(edge.from_chunk_id, 240), text(edge.to_chunk_id, 240)]).filter((id) => !seedChunkIds.includes(id))).slice(0, 20);
  if (!relatedChunkIds.length) return { edges: [], sources: [], attempted: true };
  const { data: sourceRows } = await service
    .from("legal_document_chunks")
    .select("id,version_id,unit_id,unit_order,article_number,section_path")
    .in("id", relatedChunkIds)
    .limit(20);
  const scopedSourceRows = (sourceRows ?? []).filter((row) => matchesScope(row as JsonObject, input));
  const sources = scopedSourceRows.map((row) => ({
    chunkId: row.id,
    versionId: row.version_id,
    unitId: row.unit_id,
    unitOrder: row.unit_order,
    articleNumber: row.article_number,
    sectionPath: row.section_path,
  }));
  const allowedChunkIds = new Set([...seedChunkIds, ...sources.map((source) => text(source.chunkId, 240))]);
  const scopedEdges = uniqueEdges.filter((edge) => allowedChunkIds.has(text(edge.from_chunk_id, 240)) && allowedChunkIds.has(text(edge.to_chunk_id, 240)));
  return {
    attempted: true,
    edges: scopedEdges.map((edge) => ({
      relationId: edge.id,
      relationType: edge.relation_type,
      fromDocumentId: edge.from_document_id,
      toDocumentId: edge.to_document_id,
      fromChunkId: edge.from_chunk_id,
      toChunkId: edge.to_chunk_id,
      scope: edge.relation_scope,
      confidence: edge.confidence,
      basis: edge.basis,
      citationLabel: edge.citation_label,
    })),
    sources,
  };
}

export function summarizeQuality(
  comparison: ReturnType<typeof rerankAndCompare>,
  attempts: SearchAttempt[],
  analysis: QueryAnalysis,
): QualitySummary {
  const selected = comparison.selected;
  const bestScore = selected.length ? qualityScore(selected[0], analysis) : 0;
  const modeFailures = attempts.filter((attempt) => attempt.error).map((attempt) => `${attempt.mode}:${attempt.error}`);
  const evidenceStatus: QualitySummary["evidenceStatus"] = !selected.length
    ? "insufficient"
    : bestScore >= 0.55 && selected[0].modes.size >= 2 && (keywordCoverage(selected[0], analysis) >= 0.2 || articleMatch(selected[0], analysis) > 0)
      ? "sufficient"
      : bestScore >= 0.3
        ? "weak"
        : "insufficient";
  return {
    evidenceStatus,
    candidateCount: comparison.candidateCount,
    qualityPassedCount: comparison.qualityPassedCount,
    returnedCount: selected.length,
    bestQualityScore: Number(bestScore.toFixed(6)),
    agreementTopResult: selected[0]?.modes.size ?? 0,
    passes: unique(attempts.map((attempt) => attempt.pass.toString())).length,
    failedModes: modeFailures,
    intent: analysis.intent,
  };
}