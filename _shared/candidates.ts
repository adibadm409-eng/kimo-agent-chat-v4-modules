import type { SearchMode } from "./legal-knowledge-search.ts";
import type { Candidate, JsonObject, ParsedRequest, QueryAnalysis, SearchAttempt } from "./types.ts";
import {
  DEFAULT_MATCH_THRESHOLD,
  MAX_DOCUMENT_ID_LENGTH,
  MAX_RESULTS_PER_DOCUMENT,
  MAX_SCOPE_PATH_LENGTH,
  MIN_HYBRID_SCORE,
  MIN_KEYWORD_COVERAGE,
  MIN_TEXT_RANK,
  PROMPT_WORDS,
  STOP_WORDS,
  finiteNumber,
  normalizeArabic,
  text,
  tokenize,
  unique,
} from "./utils.ts";

export function resultKey(result: JsonObject) {
  const chunkId = text(result.chunk_id, 240);
  if (chunkId) return `chunk:${chunkId}`;
  const fallback = [
    text(result.document_id, 240),
    text(result.version_id, 80),
    text(result.article_number, 100),
    text(result.section_path, 240),
    text(result.excerpt, 240).toLowerCase(),
  ].join("|");
  return fallback === "||||" ? "" : fallback;
}

function rawScore(result: JsonObject, mode: SearchMode) {
  if (mode === "hybrid") return finiteNumber(result.hybrid_score) ?? 0;
  if (mode === "vector") return finiteNumber(result.semantic_score) ?? 0;
  return finiteNumber(result.text_rank) ?? 0;
}

export function toCandidate(result: JsonObject, mode: SearchMode, rank: number, query: string, pass: number): Candidate | null {
  const key = resultKey(result);
  const documentId = text(result.document_id, 240);
  const excerpt = text(result.excerpt, 2_000);
  if (!key || !documentId || !excerpt) return null;
  return {
    key,
    raw: result,
    documentId,
    chunkId: text(result.chunk_id, 240) || null,
    titleAr: text(result.title_ar, 500) || null,
    excerpt,
    articleNumber: text(result.article_number, 100) || null,
    sectionPath: text(result.section_path, 500) || null,
    unitId: text(result.unit_id, 240) || null,
    unitOrder: finiteNumber(result.unit_order),
    modes: new Set([mode]),
    queries: new Set([query]),
    ranks: { [mode]: rank },
    rawScores: { [mode]: rawScore(result, mode) },
    passCount: pass > 1 ? 2 : 1,
  };
}

function mergeCandidate(target: Candidate, incoming: Candidate) {
  const incomingMode = [...incoming.modes][0];
  const currentRank = target.ranks[incomingMode] ?? Number.MAX_SAFE_INTEGER;
  const incomingRank = incoming.ranks[incomingMode] ?? Number.MAX_SAFE_INTEGER;
  target.modes.add(incomingMode);
  incoming.queries.forEach((query) => target.queries.add(query));
  target.passCount = Math.max(target.passCount, incoming.passCount);
  if (incomingRank < currentRank) {
    target.ranks[incomingMode] = incomingRank;
    target.rawScores[incomingMode] = incoming.rawScores[incomingMode];
  }
}

export function keywordCoverage(candidate: Candidate, analysis: QueryAnalysis) {
  const objectiveTerms = unique([
    ...analysis.keywords,
    ...tokenize(analysis.intent).filter((token) => !STOP_WORDS.has(token) && !PROMPT_WORDS.has(token)),
  ]).slice(0, 12);
  if (!objectiveTerms.length) return 0;
  const haystack = normalizeArabic(`${candidate.titleAr ?? ""} ${candidate.excerpt} ${candidate.articleNumber ?? ""}`).toLocaleLowerCase();
  const matched = objectiveTerms.filter((keyword) => haystack.includes(keyword.toLocaleLowerCase())).length;
  return matched / objectiveTerms.length;
}

export function articleMatch(candidate: Candidate, analysis: QueryAnalysis) {
  if (!analysis.articleNumbers.length) return 0;
  const articleNumber = normalizeArabic(candidate.articleNumber ?? "");
  const excerpt = normalizeArabic(candidate.excerpt);
  return analysis.articleNumbers.some((number) => {
    const normalizedNumber = normalizeArabic(number);
    return articleNumber === normalizedNumber || new RegExp(`(?:ماده|الماده|article|art\\.?)[\\s(:-]*${normalizedNumber}(?:\\D|$)`, "iu").test(excerpt);
  }) ? 1 : 0;
}

function rankFusion(candidate: Candidate) {
  const rankSum = [...candidate.modes].reduce((sum, mode) => sum + 1 / (50 + (candidate.ranks[mode] ?? 100)), 0);
  return Math.min(1, rankSum * 17);
}

function semanticEvidence(candidate: Candidate) {
  const score = candidate.rawScores.vector ?? 0;
  return Math.max(0, Math.min(1, score));
}

function textEvidence(candidate: Candidate) {
  const score = candidate.rawScores.text ?? 0;
  return Math.max(0, Math.min(1, score * 10));
}

function hybridEvidence(candidate: Candidate) {
  const score = candidate.rawScores.hybrid ?? 0;
  return Math.max(0, Math.min(1, score * 12));
}

export function qualityScore(candidate: Candidate, analysis: QueryAnalysis) {
  const modeAgreement = candidate.modes.size / 3;
  const coverage = keywordCoverage(candidate, analysis);
  const article = articleMatch(candidate, analysis);
  // عندما يطلب المستخدم مادة برقمها، مطابقة الرقم الفعلية تتفوق على أي تشابه متجهي
  const hasArticleQuery = analysis.articleNumbers.length > 0;
  const base = rankFusion(candidate) * (hasArticleQuery ? 0.25 : 0.42) +
    modeAgreement * 0.18 +
    Math.max(semanticEvidence(candidate), hybridEvidence(candidate), textEvidence(candidate)) * 0.18 +
    coverage * 0.17 +
    article * (hasArticleQuery ? 0.35 : 0.05);
  return Math.min(1, base);
}

export function passesQuality(candidate: Candidate, analysis: QueryAnalysis) {
  const coverage = keywordCoverage(candidate, analysis);
  const hybrid = candidate.rawScores.hybrid ?? 0;
  const semantic = candidate.rawScores.vector ?? 0;
  const textRank = candidate.rawScores.text ?? 0;
  const independentEvidence = candidate.modes.size >= 2;
  const strongSinglePath = DEFAULT_MATCH_THRESHOLD;
  const articleMatchScore = articleMatch(candidate, analysis);
  const objectiveRelevance = coverage >= MIN_KEYWORD_COVERAGE || articleMatchScore > 0;
  return candidate.excerpt.length >= 20 && objectiveRelevance && (
    independentEvidence ||
    semantic >= strongSinglePath ||
    hybrid >= MIN_HYBRID_SCORE ||
    (textRank >= MIN_TEXT_RANK && coverage >= MIN_KEYWORD_COVERAGE)
  );
}

export async function enrichResultIdentity(
  service: any,
  results: JsonObject[],
  cache: Map<string, JsonObject> = new Map(),
) {
  const chunkIds = unique(results.map((row) => text(row.chunk_id, 240)).filter(Boolean));
  const missingIds = chunkIds.filter((chunkId) => !cache.has(chunkId));
  if (missingIds.length) {
    const { data } = await service
      .from("legal_document_chunks")
      .select("id,version_id,unit_id,unit_order")
      .in("id", missingIds.slice(0, 100))
      .limit(Math.min(missingIds.length, 100));
    for (const row of data ?? []) cache.set(text(row.id, 240), row as JsonObject);
  }
  return results.map((row) => {
    const identity = cache.get(text(row.chunk_id, 240));
    return identity ? { ...row, unit_id: row.unit_id ?? identity.unit_id, unit_order: row.unit_order ?? identity.unit_order } : row;
  });
}

export function matchesScope(row: JsonObject, input: ParsedRequest) {
  const versionId = text(row.version_id, 80);
  const unitId = text(row.unit_id, 240);
  const sectionPath = text(row.section_path, MAX_SCOPE_PATH_LENGTH);
  if (input.versionIds?.length && !input.versionIds.includes(versionId)) return false;
  if (input.unitIds?.length && !input.unitIds.includes(unitId)) return false;
  if (input.sectionPaths?.length && !input.sectionPaths.some((path) => sectionPath === path || sectionPath.startsWith(path))) return false;
  return true;
}

export function applyScopeFilter(rows: JsonObject[], input: ParsedRequest) {
  return rows.filter((row) => matchesScope(row, input));
}

function parseHierarchy(sectionPath: string | null) {
  const path = text(sectionPath, MAX_SCOPE_PATH_LENGTH);
  const partMatch = path.match(/(?:^|>)\s*(الباب[^>]*?)(?=\s+الفصل|>|$)/i);
  const chapterMatch = path.match(/(?:^|>)\s*(الفصل[^>]*?)(?=>|$)/i);
  const partLabel = partMatch?.[1]?.trim() || null;
  const chapterLabel = chapterMatch?.[1]?.trim() || null;
  return {
    path: path || null,
    partId: null,
    chapterId: null,
    partLabel,
    chapterLabel,
    partRef: partLabel ? { kind: "section_path_label", label: partLabel, canonicalPath: path || null } : null,
    chapterRef: chapterLabel ? { kind: "section_path_label", label: chapterLabel, canonicalPath: path || null } : null,
  };
}

export function sanitizeCandidate(candidate: Candidate, analysis: QueryAnalysis) {
  const quality = qualityScore(candidate, analysis);
  return {
    chunkId: candidate.chunkId,
    documentId: candidate.documentId,
    versionId: text(candidate.raw.version_id, 80) || null,
    titleAr: candidate.titleAr,
    category: text(candidate.raw.category, 180) || null,
    jurisdictionCode: text(candidate.raw.jurisdiction_code, 32) || null,
    instrumentType: text(candidate.raw.instrument_type, 40) || null,
    legalDomain: text(candidate.raw.legal_domain, 120) || null,
    effectiveFrom: text(candidate.raw.effective_from, 40) || null,
    effectiveTo: text(candidate.raw.effective_to, 40) || null,
    articleNumber: candidate.articleNumber,
    sectionPath: candidate.sectionPath,
    unitId: candidate.unitId,
    unitOrder: candidate.unitOrder,
    hierarchy: parseHierarchy(candidate.sectionPath),
    sourceRef: {
      documentId: candidate.documentId,
      versionId: text(candidate.raw.version_id, 80) || null,
      chunkId: candidate.chunkId,
      unitId: candidate.unitId,
      unitOrder: candidate.unitOrder,
      articleNumber: candidate.articleNumber,
      sectionPath: candidate.sectionPath,
      jurisdictionCode: text(candidate.raw.jurisdiction_code, 32) || null,
      instrumentType: text(candidate.raw.instrument_type, 40) || null,
      legalDomain: text(candidate.raw.legal_domain, 120) || null,
    },
    excerpt: candidate.excerpt,
    qualityScore: Number(quality.toFixed(6)),
    keywordCoverage: Number(keywordCoverage(candidate, analysis).toFixed(6)),
    relevanceScore: Number(keywordCoverage(candidate, analysis).toFixed(6)),
    sourceAgreement: candidate.modes.size,
    provenance: {
      modes: [...candidate.modes],
      queries: [...candidate.queries],
      ranks: candidate.ranks,
      rawScores: candidate.rawScores,
      passCount: candidate.passCount,
    },
    relationCount: Math.max(0, Math.floor(finiteNumber(candidate.raw.relation_count) ?? 0)),
  };
}

function candidateRank(candidate: Candidate, mode: SearchMode) {
  return candidate.ranks[mode] ?? Number.MAX_SAFE_INTEGER;
}

export function rerankAndCompare(
  attempts: SearchAttempt[],
  analysis: QueryAnalysis,
  topK: number,
) {
  const candidates = new Map<string, Candidate>();
  for (const attempt of attempts) {
    if (!attempt.result) continue;
    attempt.result.results.forEach((result, index) => {
      const objectResult = (result && typeof result === "object" && !Array.isArray(result) ? result as JsonObject : null);
      if (!objectResult) return;
      const candidate = toCandidate(objectResult, attempt.mode, index + 1, attempt.query, attempt.pass);
      if (!candidate) return;
      const existing = candidates.get(candidate.key);
      if (existing) mergeCandidate(existing, candidate);
      else candidates.set(candidate.key, candidate);
    });
  }

  const all = [...candidates.values()];
  const qualityPassed = all.filter((candidate) => passesQuality(candidate, analysis));
  qualityPassed.sort((left, right) => {
    const scoreDifference = qualityScore(right, analysis) - qualityScore(left, analysis);
    if (scoreDifference !== 0) return scoreDifference;
    const agreementDifference = right.modes.size - left.modes.size;
    if (agreementDifference !== 0) return agreementDifference;
    return (finiteNumber(right.raw.relation_count) ?? 0) - (finiteNumber(left.raw.relation_count) ?? 0);
  });

  const selected: Candidate[] = [];
  const byDocument = new Map<string, number>();
  for (const candidate of qualityPassed) {
    if (selected.length >= topK) break;
    const count = byDocument.get(candidate.documentId) ?? 0;
    if (count >= MAX_RESULTS_PER_DOCUMENT && qualityPassed.length > topK) continue;
    byDocument.set(candidate.documentId, count + 1);
    selected.push(candidate);
  }

  const comparison = ["text", "vector", "hybrid"].map((mode) => {
    const modeAttempts = attempts.filter((attempt) => attempt.mode === mode);
    const modeKeys = new Set<string>();
    for (const candidate of all) {
      if (candidate.modes.has(mode as SearchMode)) modeKeys.add(candidate.key);
    }
    const top = [...all]
      .filter((candidate) => candidate.modes.has(mode as SearchMode))
      .sort((left, right) => (candidateRank(left, mode as SearchMode) - candidateRank(right, mode as SearchMode)))
      .slice(0, 3)
      .map((candidate) => ({ key: candidate.key, rank: candidateRank(candidate, mode as SearchMode) }));
    return {
      mode,
      attempts: modeAttempts.length,
      successfulAttempts: modeAttempts.filter((attempt) => attempt.result).length,
      uniqueCandidates: modeKeys.size,
      top,
    };
  });

  return {
    allCandidates: all,
    selected,
    comparison,
    candidateCount: all.length,
    qualityPassedCount: qualityPassed.length,
  };
}

export function articleRetrievalDiagnostic(analysis: QueryAnalysis, results: JsonObject[], attempts: SearchAttempt[], input: ParsedRequest) {
  if (!analysis.articleNumbers.length) return null;
  const matched = results.filter((result) => {
    const article = normalizeArabic(text(result.articleNumber, 100));
    const excerpt = normalizeArabic(text(result.excerpt, 3_000));
    return analysis.articleNumbers.some((number) => {
      const normalizedNumber = normalizeArabic(number);
      return article === normalizedNumber || new RegExp(`(?:ماده|الماده|article|art\\.?)[\\s(:-]*${normalizedNumber}(?:\\D|$)`, "iu").test(excerpt);
    });
  });
  const targetedAttempts = attempts.filter((attempt) => attempt.label === "article_targeted");
  return {
    requestedArticleNumbers: analysis.articleNumbers,
    status: matched.length ? "matched" : "not_matched",
    matchedResultCount: matched.length,
    targetedPassAttempted: targetedAttempts.length > 0,
    targetedPassResultCount: targetedAttempts.reduce((sum, attempt) => sum + (attempt.result?.results.length ?? 0), 0),
    requestedFilters: { jurisdictionCode: input.jurisdictionCode, instrumentType: input.instrumentType, legalDomain: input.legalDomain, documentCount: input.documentIds?.length ?? 0, versionCount: input.versionIds?.length ?? 0 },
    reasonCode: matched.length ? null : (input.legalDomain || input.jurisdictionCode || input.instrumentType || input.documentIds?.length || input.versionIds?.length ? "ARTICLE_NOT_CONFIRMED_WITH_REQUESTED_SCOPE" : "ARTICLE_NOT_CONFIRMED_IN_RETRIEVED_EVIDENCE"),
    interpretation: matched.length ? "article_number_present_in_grounding_evidence" : "no_retrieved_chunk_confirmed_the_requested_article_number;_explicit_filters_were_not_overridden",
  };
}