import type { JsonObject } from "./types.ts";

export const MAX_BODY_BYTES = 96_000;
export const MAX_QUERY_LENGTH = 800;
export const MAX_TOP_K = 20;
export const MAX_DOCUMENT_IDS = 50;
export const MAX_DOCUMENT_ID_LENGTH = 220;
export const MAX_SCOPE_IDS = 50;
export const MAX_SCOPE_PATH_LENGTH = 500;
export const DEFAULT_TOP_K = 8;
export const DEFAULT_MATCH_THRESHOLD = 0.45;
export const SEARCH_MATCH_COUNT = 24;
export const MAX_SEARCH_PASSES = 2;
export const MAX_RESULTS_PER_DOCUMENT = 3;
export const MAX_OBJECTIVE_KEYWORDS = 8;
export const MAX_AI_QUERY_VARIANTS = 3;
export const MIN_TEXT_RANK = 0.05;
export const MIN_HYBRID_SCORE = 0.015;
export const MIN_KEYWORD_COVERAGE = 0.2;

export const STOP_WORDS = new Set([
  "ما", "ماذا", "هل", "هو", "هي", "هم", "من", "في", "على", "عن", "إلى", "الى", "مع", "هذا", "هذه", "ذلك", "تلك", "التي", "الذي", "و", "أو", "او", "أن", "ان", "إن", "لا", "لم", "لن", "لقد", "قد", "كان", "كانت", "يكون", "تكون", "يتم", "يمكن", "عند", "بعد", "قبل", "بين", "ضمن", "بموجب", "بخصوص", "حول", "لي", "لنا", "لدي", "لدى", "هل", "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "what", "which", "how", "is", "are", "be", "under", "regarding",
]);

export const PROMPT_WORDS = new Set(["اريد", "أريد", "افهم", "أفهم", "يريد", "يسأل", "شخص", "بشكل", "عام", "ما", "ماذا", "هل", "هي", "هو", "هذا", "هذه", "يجب", "ينبغي", "قبل", "بعد", "اولا", "أولا", "اولاً", "أولاً", "منه", "عليه", "علي", "لدي", "لديّ", "يمكن", "كيف", "لماذا"]);

export const INTENT_TERMS: Record<string, string[]> = {
  definition: ["تعريف", "ماهية", "مفهوم", "definition"],
  elements: ["شروط", "أركان", "متطلبات", "elements", "requirements"],
  rights: ["حقوق", "حق", "استحقاق", "rights", "entitlement"],
  obligations: ["التزامات", "واجبات", "يلتزم", "obligations", "duties"],
  procedure: ["إجراء", "دعوى", "طلب", "اختصاص", "procedure", "filing"],
  penalty: ["جزاء", "عقوبة", "غرامة", "مسؤولية", "penalty", "sanction"],
  duration: ["مدة", "ميعاد", "تقادم", "انتهاء", "duration", "limitation"],
  exception: ["استثناء", "يستثنى", "شرط خاص", "exception", "exclusion"],
  comparison: ["مقارنة", "الفرق", "تمييز", "compare", "difference"],
  application: ["تطبيق", "كيف", "عملي", "نموذج", "application", "practical"],
  general: ["قانون", "نظام", "لائحة", "مادة", "legal", "law"],
};

export function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

export function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function boundedFloat(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function finiteNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export function textArray(value: unknown, maxItems: number, maxLength: number) {
  return Array.isArray(value)
    ? unique(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, maxLength)).filter(Boolean)).slice(0, maxItems)
    : [];
}

export function normalizeArabic(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) >= 0x06F0 ? digit.charCodeAt(0) - 0x06F0 : digit.charCodeAt(0) - 0x0660))
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ـ/g, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value: string) {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
}

export function extractNumbers(query: string, pattern: RegExp) {
  return unique([...query.matchAll(pattern)].map((match) => match[1] ?? match[0]).slice(0, 8));
}

export function normalizeDocumentIds(value: unknown, max = MAX_DOCUMENT_IDS, maxLength = MAX_DOCUMENT_ID_LENGTH) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error("INVALID_SCOPE_FILTER");
  if (value.length > max) throw new Error("SCOPE_FILTER_LIMIT_EXCEEDED");
  const ids = value.map((item) => {
    if (typeof item !== "string") throw new Error("INVALID_SCOPE_FILTER");
    const normalized = item.trim();
    if (!normalized || normalized.length > maxLength) throw new Error("INVALID_SCOPE_FILTER");
    return normalized;
  });
  return ids.length ? unique(ids) : null;
}

export function safeStringList(value: unknown, maxLength: number, maxItems = 50) {
  return Array.isArray(value)
    ? unique(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, maxLength)).filter(Boolean)).slice(0, maxItems)
    : [];
}