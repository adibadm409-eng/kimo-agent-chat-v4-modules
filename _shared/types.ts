import type { LegalKnowledgeSearchResult, SearchMode } from "./legal-knowledge-search.ts";


export type JsonObject = Record<string, unknown>;
export type EvidenceStatus = "sufficient" | "weak" | "insufficient";
export type AiAnalysis = {
  intent: string;
  subQuestions: string[];
  searchQueries: string[];
  keywords: string[];
  entities: { jurisdiction: string | null; instrument: string | null; domain: string | null; dates: string[] };
  ambiguity: string | null;
};
export type ClaimCitation = {
  index: number;
  titleAr: string | null;
  category: string | null;
  documentId: string | null;
  versionId: string | null;
  chunkId: string | null;
  articleNumber: string | null;
  sectionPath: string | null;
  verbatimQuote: string | null;
};

export type ClaimAttribution = {
  claim: string;
  citationIndexes: number[];
  citations: ClaimCitation[];
};

export type ComparisonAttribution = {
  sourceLabel: string;
  finding: string;
  citationIndexes: number[];
  citations: ClaimCitation[];
};

export type AnswerGroundingStatus = "grounded" | "partial" | "unmapped" | "no_evidence";

export type AiAnswer = {
  answer: string;
  caveats: string[];
  citationIndexes: number[];
  claims: ClaimAttribution[];
  comparisonMatrix: ComparisonAttribution[];
  answerGrounding: AnswerGroundingStatus;
  confidence: "high" | "medium" | "low";
};

export type RequestBody = {
  query?: unknown;
  question?: unknown;
  mode?: unknown;
  topK?: unknown;
  matchThreshold?: unknown;
  jurisdictionCode?: unknown;
  instrumentType?: unknown;
  legalDomain?: unknown;
  documentIds?: unknown;
  versionIds?: unknown;
  unitIds?: unknown;
  sectionPaths?: unknown;
  retrievalScope?: unknown;
  includeRelated?: unknown;
  sourceDiscovery?: unknown;
  comparison?: unknown;
  searchSkill?: unknown;
  idempotencyKey?: unknown;
  analysisMode?: unknown;
  orchestration?: unknown;
};

export type ComparisonControl = {
  enabled: boolean;
  answerMode: "single_cluster" | "multi_source";
  maxSources: number;
  maxResultsPerSource: number;
};

export type SearchSkillControl = {
  enabled: boolean;
  profileKey: string | null;
  profileOwner: string | null;
};

export type AnalysisMode = "auto" | "fast" | "deep";
export type OrchestrationMode = "single" | "adaptive" | "parallel_research" | "deep_review";
export type WorkerRole = "retrieval" | "article_verification" | "critical_review";
export type OrchestrationControl = {
  enabled: boolean;
  mode: OrchestrationMode;
  maxWorkers: number;
  timeoutMs: number;
};

export type SourceDiscoveryControl = {
  enabled: boolean;
  mode: "parallel" | "route_then_retrieve";
  reviewMode: "none" | "heuristic" | "ai";
  outputMode: "routing" | "source_map" | "compact";
  maxSources: number;
  autoScope: boolean;
};

export type QueryAnalysis = {
  original: string;
  normalized: string;
  intent: string;
  intentTerms: string[];
  keywords: string[];
  articleNumbers: string[];
  years: string[];
  entities: {
    jurisdictionCode: string | null;
    instrumentType: string | null;
    legalDomain: string | null;
  };
  canonicalQuery: string;
  lawSpecified: boolean;
  keywordQuery: string;
  semanticQuery: string;
  alternativeQuery: string;
};

export type SearchAttempt = {
  pass: number;
  label: string;
  query: string;
  mode: SearchMode;
  result: LegalKnowledgeSearchResult | null;
  error: string | null;
  latencyMs: number;
};

export type Candidate = {
  key: string;
  raw: JsonObject;
  documentId: string;
  chunkId: string | null;
  titleAr: string | null;
  excerpt: string;
  articleNumber: string | null;
  sectionPath: string | null;
  unitId: string | null;
  unitOrder: number | null;
  modes: Set<SearchMode>;
  queries: Set<string>;
  ranks: Partial<Record<SearchMode, number>>;
  rawScores: Partial<Record<SearchMode, number>>;
  passCount: number;
};

export type WorkerClaim = {
  claim: string;
  citationIndexes: number[];
  supportLevel: "direct" | "inference" | "unverified";
};

export type WorkerResult = {
  role: WorkerRole;
  status: "completed" | "failed" | "skipped";
  claims: WorkerClaim[];
  conflicts: string[];
  limitations: string[];
  sourceRefs: JsonObject[];
  latencyMs: number;
  model: { provider: string; model: string } | null;
  error?: string;
};

export type OrchestrationResult = {
  enabled: boolean;
  mode: OrchestrationMode;
  workers: WorkerResult[];
  arbitration: {
    status: "convergent" | "review_required" | "insufficient_worker_agreement";
    completedWorkerCount: number;
    conflictCount: number;
    validWorkerClaimCount: number;
    policy: string;
  };
};

export type ParsedRequest = {
  query: string;
  topK: number;
  matchThreshold: number;
  jurisdictionCode: string | null;
  instrumentType: string | null;
  legalDomain: string | null;
  documentIds: string[] | null;
  versionIds: string[] | null;
  unitIds: string[] | null;
  sectionPaths: string[] | null;
  retrievalScope: "narrow" | "normal" | "wide";
  includeRelated: boolean;
  comparison: ComparisonControl;
  orchestration: OrchestrationControl;
  searchSkill: SearchSkillControl;
  sourceDiscovery: SourceDiscoveryControl;
  idempotencyKey: string;
  analysisMode: AnalysisMode;
};