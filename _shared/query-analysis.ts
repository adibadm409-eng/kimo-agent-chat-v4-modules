import { invokeConfiguredModel, parseModelJson } from "./ai-provider.ts";
import type { AiAnalysis, JsonObject, ParsedRequest, QueryAnalysis } from "./types.ts";
import {
  INTENT_TERMS,
  MAX_AI_QUERY_VARIANTS,
  MAX_OBJECTIVE_KEYWORDS,
  MAX_QUERY_LENGTH,
  PROMPT_WORDS,
  STOP_WORDS,
  extractNumbers,
  normalizeArabic,
  text,
  textArray,
  tokenize,
  unique,
} from "./utils.ts";

function detectIntent(query: string) {
  const tokens = new Set(tokenize(query));
  let best = "general";
  let bestScore = 0;
  for (const [intent, terms] of Object.entries(INTENT_TERMS)) {
    const score = terms.reduce((sum, term) => {
      const normalizedTerm = normalizeArabic(term).toLocaleLowerCase();
      return sum + (query.toLocaleLowerCase().includes(normalizedTerm) || tokens.has(normalizedTerm) ? 1 : 0);
    }, 0);
    if (score > bestScore) {
      best = intent;
      bestScore = score;
    }
  }
  return best;
}

export function buildQueryAnalysis(
  original: string,
  filters: { jurisdictionCode: string | null; instrumentType: string | null; legalDomain: string | null },
  scope: { documentIds: string[] | null } = { documentIds: null },
): QueryAnalysis {
  const normalized = normalizeArabic(original);
  const tokens = tokenize(normalized);
  const keywords = unique(tokens.filter((token) => {
    if (/^\d+$/.test(token)) return true;
    if (STOP_WORDS.has(token) || PROMPT_WORDS.has(token)) return false;
    return token.length >= 2;
  })).slice(0, MAX_OBJECTIVE_KEYWORDS);
  const articleNumbers = extractNumbers(normalized, /(?:ماده|مادة|الماده|المادة|art(?:icle)?)[\s(:-]*(\d{1,6})/giu);
  const years = extractNumbers(normalized, /(?:سنه|سنة|عام|قانون|law)[\s(:/-]*(\d{4})/giu);
  const intent = detectIntent(normalized);
  const intentTerms = INTENT_TERMS[intent] ?? INTENT_TERMS.general;
  // تحديد القانون: ذكر صريح لأداة تشريعية (قانون/نظام/لائحة/مرسوم/تعليمات/قرار)
  // أو فلاتر وثائق صريحة من المستدعي. رقم المادة وحده لا يحدد القانون أبداً.
  const lawMentioned = /(?:قانون|القانون|نظام|النظام|لائحة|اللائحة|مرسوم|المرسوم|تعليمات|التعليمات|قرار|القرار)/.test(normalized);
  const lawSpecified = lawMentioned || Boolean(scope.documentIds && scope.documentIds.length > 0);
  const articleQuery = lawSpecified ? articleNumbers : [];
  const entityTerms = [filters.jurisdictionCode, filters.instrumentType, filters.legalDomain].filter(Boolean) as string[];
  const canonicalQuery = unique([normalized, ...articleQuery.map((value) => `مادة ${value}`), ...entityTerms]).join(" ").slice(0, MAX_QUERY_LENGTH);
  const keywordQuery = unique([...keywords, ...articleQuery.map((value) => `مادة ${value}`), ...years, ...entityTerms]).slice(0, MAX_OBJECTIVE_KEYWORDS + 4).join(" ").slice(0, MAX_QUERY_LENGTH);
  const semanticQuery = unique([normalized, ...keywords.slice(0, MAX_OBJECTIVE_KEYWORDS), ...articleQuery.map((value) => `مادة ${value}`)]).join(" ").slice(0, MAX_QUERY_LENGTH);
  const alternativeQuery = unique([
    ...keywords.slice(0, MAX_OBJECTIVE_KEYWORDS),
    ...articleQuery.map((value) => `مادة ${value}`),
    ...years,
    ...entityTerms,
  ]).join(" ").slice(0, MAX_QUERY_LENGTH);
  return {
    original,
    normalized,
    intent,
    intentTerms: intentTerms.slice(0, 6),
    keywords,
    articleNumbers,
    years,
    entities: filters,
    lawSpecified,
    canonicalQuery,
    keywordQuery: keywordQuery || canonicalQuery,
    semanticQuery,
    alternativeQuery: alternativeQuery || canonicalQuery,
  };
}

export function fallbackAiAnalysis(baseline: QueryAnalysis): AiAnalysis {
  return {
    intent: baseline.intent,
    subQuestions: [baseline.normalized].slice(0, 4),
    searchQueries: unique([baseline.canonicalQuery, baseline.keywordQuery, baseline.semanticQuery]).slice(0, 4),
    keywords: baseline.keywords.slice(0, 24),
    entities: {
      jurisdiction: baseline.entities.jurisdictionCode,
      instrument: baseline.entities.instrumentType,
      domain: baseline.entities.legalDomain,
      dates: baseline.years.slice(0, 8),
    },
    ambiguity: null,
  };
}

function normalizeAiAnalysis(value: unknown, baseline: QueryAnalysis): AiAnalysis {
  const object = (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
  const entitiesRaw = (object.entities && typeof object.entities === "object" && !Array.isArray(object.entities) ? object.entities as JsonObject : {});
  const fallback = fallbackAiAnalysis(baseline);
  const keywords = textArray(object.keywords, MAX_OBJECTIVE_KEYWORDS, 100);
  const searchQueries = textArray(object.searchQueries ?? object.queries, MAX_AI_QUERY_VARIANTS, 360);
  const subQuestions = textArray(object.subQuestions, 4, 500);
  return {
    intent: text(object.intent, 160) || fallback.intent,
    subQuestions: subQuestions.length ? subQuestions : fallback.subQuestions,
    searchQueries: searchQueries.length ? searchQueries : fallback.searchQueries,
    keywords: keywords.length ? keywords : fallback.keywords,
    entities: {
      jurisdiction: text(entitiesRaw.jurisdiction, 120) || fallback.entities.jurisdiction,
      instrument: text(entitiesRaw.instrument, 160) || fallback.entities.instrument,
      domain: text(entitiesRaw.domain, 160) || fallback.entities.domain,
      dates: textArray(entitiesRaw.dates, 8, 60),
    },
    ambiguity: text(object.ambiguity, 500) || null,
  };
}

export async function improveQueryWithAi(
  service: any,
  input: ParsedRequest,
  baseline: QueryAnalysis,
) {
  const fallback = fallbackAiAnalysis(baseline);
  try {
    const result = await invokeConfiguredModel(service, {
      stage: "query_analysis",
      question: input.query,
      instruction: "حلل سؤال المستخدم الطبيعي بغض النظر عن المجال القانوني. استخرج النية الفعلية، الأسئلة الفرعية، الكيانات والاختصاص والزمن إن ظهرت، ثم أنشئ من 2 إلى 4 صيغ بحث مستقلة مناسبة للبحث النصي والمتجهي والهجين. لا تضف معلومات غير موجودة. أعد JSON فقط بالمفاتيح: intent, subQuestions, searchQueries, keywords, entities { jurisdiction, instrument, domain, dates }, ambiguity.",
      payload: { baseline, filters: { jurisdictionCode: input.jurisdictionCode, instrumentType: input.instrumentType, legalDomain: input.legalDomain } },
      maxOutputTokens: 900,
    });
    return { analysis: normalizeAiAnalysis(parseModelJson<unknown>(result.output), baseline), model: { provider: result.provider, model: result.model, latencyMs: result.latencyMs, usage: result.usage } };
  } catch (error) {
    console.warn("kimo query analysis fallback", error instanceof Error ? error.message : "AI_ANALYSIS_FAILED");
    return { analysis: fallback, model: null };
  }
}

export function shouldUseAiAnalysis(input: ParsedRequest, baseline: QueryAnalysis) {
  if (input.analysisMode === "fast") return false;
  if (input.analysisMode === "deep") return true;
  return baseline.articleNumbers.length > 0 || baseline.keywords.length < 3 || baseline.normalized.length > 220 || input.comparison.enabled || input.sourceDiscovery.enabled;
}

// مسار سريع: سؤال واضح (كلمات كافية، لا أرقام مواد، قصير نسبياً) لا يحتاج تحليل AI إضافي
export function canSkipAiAnalysis(baseline: QueryAnalysis) {
  return baseline.keywords.length >= 3 && baseline.articleNumbers.length === 0 && baseline.normalized.length <= 220;
}

export function deterministicAiAnalysis(baseline: QueryAnalysis): AiAnalysis {
  return {
    intent: baseline.intent,
    subQuestions: [],
    searchQueries: [baseline.canonicalQuery],
    keywords: baseline.keywords,
    entities: { jurisdiction: baseline.entities.jurisdictionCode, instrument: baseline.entities.instrumentType, domain: baseline.entities.legalDomain, dates: baseline.years },
    ambiguity: null,
  };
}

export function applyAiAnalysis(baseline: QueryAnalysis, ai: AiAnalysis): QueryAnalysis {
  const combinedKeywords = unique([...baseline.keywords, ...ai.keywords]).slice(0, MAX_OBJECTIVE_KEYWORDS);
  const entityTerms = [ai.entities.jurisdiction, ai.entities.instrument, ai.entities.domain].filter(Boolean) as string[];
  const canonicalQuery = baseline.normalized.slice(0, MAX_QUERY_LENGTH);
  const keywordQuery = unique([...combinedKeywords, ...baseline.articleNumbers.map((value) => `مادة ${value}`), ...baseline.years, ...entityTerms]).slice(0, MAX_OBJECTIVE_KEYWORDS + 4).join(" ").slice(0, MAX_QUERY_LENGTH);
  const semanticQuery = canonicalQuery;
  const alternativeQuery = (ai.searchQueries[0] || keywordQuery || canonicalQuery).slice(0, 360);
  return {
    ...baseline,
    intent: ai.intent || baseline.intent,
    intentTerms: unique([...baseline.intentTerms, ...tokenize(ai.intent).filter((token) => !STOP_WORDS.has(token) && !PROMPT_WORDS.has(token))]).slice(0, 8),
    keywords: combinedKeywords,
    entities: {
      jurisdictionCode: ai.entities.jurisdiction || baseline.entities.jurisdictionCode,
      instrumentType: ai.entities.instrument || baseline.entities.instrumentType,
      legalDomain: ai.entities.domain || baseline.entities.legalDomain,
    },
    canonicalQuery,
    keywordQuery,
    semanticQuery,
    alternativeQuery,
  };
}