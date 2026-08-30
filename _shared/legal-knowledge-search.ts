import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

type ServiceClient = ReturnType<typeof createClient>;
export type SearchMode = "text" | "vector" | "hybrid";

export type SearchProfile = {
  profileKey: string;
  modelKey: string;
  modelVersion: string;
  fullTextWeight: number;
  semanticWeight: number;
  defaultThreshold: number;
  maxResults: number;
};

export type LegalKnowledgeSearchRequest = {
  query: string;
  mode?: SearchMode;
  matchCount?: number;
  matchThreshold?: number;
  jurisdictionCode?: string | null;
  instrumentType?: string | null;
  legalDomain?: string | null;
  documentIds?: string[] | null;
  includeNonActive?: boolean;
  idempotencyKey?: string;
  queryEmbedding?: number[] | null;
  profileKey?: string | null;
  profileOwner?: string | null;
};

export type NormalizedLegalKnowledgeSearchRequest = {
  query: string;
  mode: SearchMode;
  matchCount: number;
  matchThreshold: number;
  jurisdictionCode: string | null;
  instrumentType: string | null;
  legalDomain: string | null;
  documentIds: string[] | null;
  includeNonActive: boolean;
  idempotencyKey: string | null;
  queryEmbedding?: number[] | null;
  profileKey?: string | null;
  profileOwner?: string | null;
};

export type LegalKnowledgeSearchResult = {
  mode: SearchMode;
  model: { key: string; version: string; dimensions: number } | null;
  results: Record<string, unknown>[];
  queryLength: number;
  profile: SearchProfile;
};

const MODEL_SESSION_ID = "gte-small";
const MODEL_KEY = "supabase/gte-small";
const MODEL_VERSION = "gte-small-v1";
const MODEL_DIMENSIONS = 384;
const MAX_QUERY_LENGTH = 800;
const MAX_MATCH_COUNT = 50;
const DEFAULT_THRESHOLD = 0.45;
const DEFAULT_PROFILE_KEY = "default";
const BUILTIN_PROFILES: Record<string, SearchProfile> = {
  [DEFAULT_PROFILE_KEY]: { profileKey: DEFAULT_PROFILE_KEY, modelKey: MODEL_KEY, modelVersion: MODEL_VERSION, fullTextWeight: 0.4, semanticWeight: 0.6, defaultThreshold: 0.6, maxResults: 20 },
};
const profileCache = new Map<string, Promise<SearchProfile>>();

type EmbeddingSession = {
  run: (input: string, options: { mean_pool: boolean; normalize: boolean }) => Promise<Iterable<number>>;
};

let embeddingSession: EmbeddingSession | null = null;
const EMBEDDING_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 45 * 1000;
const MAX_EMBEDDING_CACHE_ENTRIES = 128;
const MAX_SEARCH_CACHE_ENTRIES = 128;
const embeddingCache = new Map<string, { expiresAt: number; value: Promise<number[]> }>();
const searchCache = new Map<string, { expiresAt: number; value: Promise<LegalKnowledgeSearchResult> }>();

function cacheKeyText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase().slice(0, MAX_QUERY_LENGTH);
}

function pruneCache<T>(cache: Map<string, T>, maxEntries: number) {
  while (cache.size >= maxEntries) {
    const first = cache.keys().next().value as string | undefined;
    if (!first) break;
    cache.delete(first);
  }
}

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function boundedFloat(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function optionalFilter(value: unknown, max: number) {
  const cleaned = cleanText(value, max);
  return cleaned || null;
}

function normalizeDocumentIds(value: unknown) {
  if (!Array.isArray(value)) return null;
  const ids = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 220))
    .filter(Boolean)
    .slice(0, 50);
  return ids.length ? ids : null;
}

function vectorLiteral(values: number[]) {
  if (values.length !== MODEL_DIMENSIONS || values.some((value) => !Number.isFinite(value))) {
    throw new Error("EMBEDDING_DIMENSION_MISMATCH");
  }
  return `[${values.map((value) => Number(value).toPrecision(9)).join(",")}]`;
}

export async function generateLegalKnowledgeEmbedding(input: string) {
  const key = cacheKeyText(input);
  const now = Date.now();
  const cached = embeddingCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) embeddingCache.delete(key);
  pruneCache(embeddingCache, MAX_EMBEDDING_CACHE_ENTRIES);
  const value = (async () => {
    embeddingSession ??= new Supabase.ai.Session(MODEL_SESSION_ID);
    const output = await embeddingSession.run(input, {
      mean_pool: true,
      normalize: true,
    });
    const values = Array.from(output as Iterable<number>, Number);
    if (values.length !== MODEL_DIMENSIONS || values.some((number) => !Number.isFinite(number))) {
      throw new Error("EMBEDDING_DIMENSION_MISMATCH");
    }
    return values;
  })();
  embeddingCache.set(key, { expiresAt: now + EMBEDDING_CACHE_TTL_MS, value });
  try {
    return await value;
  } catch (error) {
    embeddingCache.delete(key);
    throw error;
  }
}

export async function loadLegalKnowledgeSearchProfile(service: ServiceClient, profileKey?: string | null, profileOwner?: string | null): Promise<SearchProfile> {
  const requestedKey = cleanText(profileKey, 120);
  const owner = cleanText(profileOwner, 120);
  const cacheKey = requestedKey ? `key:${requestedKey}` : owner ? `owner:${owner}` : `key:${DEFAULT_PROFILE_KEY}`;
  const cached = profileCache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    const fallback = BUILTIN_PROFILES[DEFAULT_PROFILE_KEY];
    let query = service.from("legal_knowledge_search_profiles").select("profile_key,model_key,model_version,full_text_weight,semantic_weight,default_threshold,max_results,is_active").eq("is_active", true).limit(1);
    query = requestedKey ? query.eq("profile_key", requestedKey) : owner ? query.eq("metadata->>owner", owner).order("updated_at", { ascending: false }) : query.eq("profile_key", DEFAULT_PROFILE_KEY);
    const { data, error } = await query.maybeSingle();
    if (error || !data) return fallback;
    return {
      profileKey: cleanText(data.profile_key, 120) || fallback.profileKey,
      modelKey: cleanText(data.model_key, 160) || fallback.modelKey,
      modelVersion: cleanText(data.model_version, 120) || fallback.modelVersion,
      fullTextWeight: boundedFloat(data.full_text_weight, fallback.fullTextWeight, 0, 10),
      semanticWeight: boundedFloat(data.semantic_weight, fallback.semanticWeight, 0, 10),
      defaultThreshold: boundedFloat(data.default_threshold, fallback.defaultThreshold, -1, 1),
      maxResults: boundedInt(data.max_results, fallback.maxResults, 1, MAX_MATCH_COUNT),
    };
  })();
  profileCache.set(cacheKey, promise);
  return promise;
}

export function normalizeLegalKnowledgeSearchRequest(input: unknown): NormalizedLegalKnowledgeSearchRequest {
  const body = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const query = cleanText(body.query, MAX_QUERY_LENGTH);
  if (!query || /^(?:[\p{P}\p{S}\s])+$/u.test(query)) throw new Error("INVALID_SEARCH_QUERY");
  const mode = body.mode === "vector" || body.mode === "hybrid" ? body.mode : "text";
  const idempotencyKey = cleanText(body.idempotencyKey, 160) || null;
  return {
    query,
    mode,
    matchCount: boundedInt(body.matchCount, 12, 1, MAX_MATCH_COUNT),
    matchThreshold: boundedFloat(body.matchThreshold, DEFAULT_THRESHOLD, -1, 1),
    jurisdictionCode: optionalFilter(body.jurisdictionCode, 32),
    instrumentType: optionalFilter(body.instrumentType, 40),
    legalDomain: optionalFilter(body.legalDomain, 120),
    documentIds: normalizeDocumentIds(body.documentIds),
    includeNonActive: body.includeNonActive === true,
    idempotencyKey,
    queryEmbedding: Array.isArray(body.queryEmbedding)
      ? body.queryEmbedding.filter((value): value is number => typeof value === "number")
      : null,
    profileKey: cleanText(body.profileKey, 120) || null,
    profileOwner: cleanText(body.profileOwner, 120) || null,
  };
}

export function fuseHybridResults(textResults: Record<string, unknown>[], vectorResults: Record<string, unknown>[], matchCount: number, weights: { fullTextWeight?: number; semanticWeight?: number } = {}) {
  const fused = new Map<string, Record<string, unknown>>();
  const keyOf = (row: Record<string, unknown>, index: number) => {
    const chunkId = typeof row.chunk_id === "string" ? row.chunk_id : "";
    return chunkId || `${String(row.document_id ?? "")}|${String(row.article_number ?? "")}|${String(row.section_path ?? "")}|${index}`;
  };
  const add = (row: Record<string, unknown>, mode: "text" | "vector", index: number) => {
    const key = keyOf(row, index);
    const current = fused.get(key) ?? { ...row };
    const rankKey = mode === "text" ? "text_rank_position" : "vector_rank_position";
    const scoreKey = mode === "text" ? "text_rank" : "semantic_score";
    current[rankKey] = Math.min(Number(current[rankKey] ?? Number.MAX_SAFE_INTEGER), index + 1);
    if (row[scoreKey] !== undefined) current[scoreKey] = row[scoreKey];
    for (const field of ["chunk_id", "document_id", "version_id", "title_ar", "category", "article_number", "section_path", "excerpt", "relation_count"]) {
      if (current[field] == null && row[field] != null) current[field] = row[field];
    }
    fused.set(key, current);
  };
  textResults.forEach((row, index) => add(row, "text", index));
  vectorResults.forEach((row, index) => add(row, "vector", index));
  return [...fused.values()]
    .map((row) => {
      const textPosition = Number(row.text_rank_position ?? 1000);
      const vectorPosition = Number(row.vector_rank_position ?? 1000);
      const fullTextWeight = Math.max(0, Number(weights.fullTextWeight ?? 0.45));
      const semanticWeight = Math.max(0, Number(weights.semanticWeight ?? 0.55));
      const totalWeight = fullTextWeight + semanticWeight || 1;
      const hybridScore = (fullTextWeight / totalWeight) / (50 + textPosition) + (semanticWeight / totalWeight) / (50 + vectorPosition);
      return { ...row, hybrid_score: hybridScore, text_rank_position: undefined, vector_rank_position: undefined };
    })
    .sort((left, right) => Number(right.hybrid_score ?? 0) - Number(left.hybrid_score ?? 0))
    .slice(0, Math.min(Math.max(matchCount, 1), 100));
}

async function searchLegalKnowledgeUncached(
  service: ServiceClient,
  request: NormalizedLegalKnowledgeSearchRequest,
): Promise<LegalKnowledgeSearchResult> {
  const profile = await loadLegalKnowledgeSearchProfile(service, request.profileKey, request.profileOwner);
  const effectiveMatchCount = Math.min(request.matchCount, profile.maxResults, MAX_MATCH_COUNT);
  const common = {
    p_match_count: effectiveMatchCount,
    p_jurisdiction_code: request.jurisdictionCode,
    p_instrument_type: request.instrumentType,
    p_legal_domain: request.legalDomain,
    p_document_ids: request.documentIds,
    p_include_non_active: request.includeNonActive,
  };
  if (request.mode === "text") {
    const { data, error } = await service.rpc("search_legal_knowledge_text", {
      p_query: request.query,
      ...common,
    });
    if (error) throw new Error("TEXT_SEARCH_FAILED");
    return { mode: "text", model: null, results: Array.isArray(data) ? data : [], queryLength: request.query.length, profile };
  }

  const queryEmbedding = request.queryEmbedding ?? await generateLegalKnowledgeEmbedding(request.query);
  const embedding = vectorLiteral(queryEmbedding);
  if (request.mode === "vector") {
    const { data, error } = await service.rpc("search_legal_knowledge_vector", {
      p_query_embedding: embedding,
      p_match_threshold: request.matchThreshold,
      p_model_key: profile.modelKey,
      p_model_version: profile.modelVersion,
      ...common,
    });
    if (error) throw new Error("VECTOR_SEARCH_FAILED");
    return {
      mode: "vector",
      model: { key: profile.modelKey, version: profile.modelVersion, dimensions: MODEL_DIMENSIONS },
      results: Array.isArray(data) ? data : [],
      queryLength: request.query.length,
      profile,
    };
  }

  const [textResponse, vectorResponse] = await Promise.all([
    service.rpc("search_legal_knowledge_text", { p_query: request.query, ...common }),
    service.rpc("search_legal_knowledge_vector", {
      p_query_embedding: embedding,
      p_match_threshold: request.matchThreshold,
      p_model_key: profile.modelKey,
      p_model_version: profile.modelVersion,
      ...common,
    }),
  ]);
  if (textResponse.error) throw new Error("HYBRID_TEXT_SEARCH_FAILED");
  if (vectorResponse.error) throw new Error("HYBRID_VECTOR_SEARCH_FAILED");
  return {
    mode: "hybrid",
    model: { key: profile.modelKey, version: profile.modelVersion, dimensions: MODEL_DIMENSIONS },
    results: fuseHybridResults(Array.isArray(textResponse.data) ? textResponse.data : [], Array.isArray(vectorResponse.data) ? vectorResponse.data : [], effectiveMatchCount, profile),
    queryLength: request.query.length,
    profile,
  };
}

export async function searchLegalKnowledge(
  service: ServiceClient,
  request: NormalizedLegalKnowledgeSearchRequest,
): Promise<LegalKnowledgeSearchResult> {
  const profile = await loadLegalKnowledgeSearchProfile(service, request.profileKey, request.profileOwner);
  const key = JSON.stringify({
    query: cacheKeyText(request.query),
    mode: request.mode,
    matchCount: request.matchCount,
    matchThreshold: request.matchThreshold,
    jurisdictionCode: request.jurisdictionCode,
    instrumentType: request.instrumentType,
    legalDomain: request.legalDomain,
    documentIds: request.documentIds,
    includeNonActive: request.includeNonActive,
    profileKey: profile.profileKey,
    modelKey: profile.modelKey,
    modelVersion: profile.modelVersion,
    queryEmbeddingFingerprint: request.queryEmbedding ? `${request.queryEmbedding[0]}|${request.queryEmbedding[request.queryEmbedding.length - 1]}|${request.queryEmbedding.length}` : null,
  });
  const now = Date.now();
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) searchCache.delete(key);
  pruneCache(searchCache, MAX_SEARCH_CACHE_ENTRIES);
  const value = searchLegalKnowledgeUncached(service, { ...request, profileKey: profile.profileKey, profileOwner: null });
  searchCache.set(key, { expiresAt: now + SEARCH_CACHE_TTL_MS, value });
  try {
    return await value;
  } catch (error) {
    searchCache.delete(key);
    throw error;
  }
}

export const legalKnowledgeSearchConstants = {
  modelSessionId: MODEL_SESSION_ID,
  modelKey: MODEL_KEY,
  modelVersion: MODEL_VERSION,
  dimensions: MODEL_DIMENSIONS,
  maxQueryLength: MAX_QUERY_LENGTH,
  maxMatchCount: MAX_MATCH_COUNT,
};
