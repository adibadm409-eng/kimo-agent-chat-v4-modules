import { invokeConfiguredModel, parseModelJson } from "./ai-provider.ts";
import type { AiAnswer, ClaimAttribution, ComparisonControl, JsonObject, OrchestrationResult, ParsedRequest, QueryAnalysis } from "./types.ts";
import { MAX_DOCUMENT_ID_LENGTH, MAX_SCOPE_PATH_LENGTH, asObject, finiteNumber, text, textArray, unique } from "./utils.ts";

export type QualitySummary = {
  evidenceStatus: "sufficient" | "weak" | "insufficient";
  candidateCount: number;
  qualityPassedCount: number;
  returnedCount: number;
  bestQualityScore: number;
  agreementTopResult: number;
  passes: number;
  failedModes: string[];
  intent: string;
};

export function fallbackAnswer(quality: QualitySummary, resultCount: number): AiAnswer {
  if (quality.evidenceStatus === "insufficient") return { answer: "لم تتوفر أدلة قانونية كافية للإجابة بثقة على السؤال المطروح.", caveats: ["ينبغي توفير نص أو اختصاص أو تاريخ نفاذ أكثر تحديداً قبل بناء نتيجة قانونية."], citationIndexes: [], claims: [], comparisonMatrix: [], answerGrounding: resultCount ? "unmapped" : "no_evidence", confidence: "low" };
  return { answer: `تم العثور على ${resultCount} مقتطفات قانونية مرشحة، لكن لم تتكون بعد ادعاءات قانونية قابلة للإسناد جملةً بجملة.`, caveats: ["هذه نتيجة بحث أولية وليست بديلاً عن التحقق من المصدر القانوني الكامل."], citationIndexes: resultCount ? [1] : [], claims: [], comparisonMatrix: [], answerGrounding: resultCount ? "unmapped" : "no_evidence", confidence: "low" };
}

export function selectGroundingResults(results: JsonObject[], control: ComparisonControl) {
  if (results.length <= 1) return results;
  const multiSource = control.enabled && control.answerMode === "multi_source";
  const groups = new Map<string, JsonObject[]>();
  for (const result of results) {
    const key = `${text(result.documentId, MAX_DOCUMENT_ID_LENGTH)}|${text(result.versionId, 80)}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(result);
    groups.set(key, bucket);
  }
  const ranked = [...groups.entries()].map(([key, rows]) => {
    const scores = rows.map((row) => Math.max(0, Math.min(1, finiteNumber(row.qualityScore) ?? 0)));
    const agreements = rows.map((row) => Math.max(0, Math.min(3, finiteNumber(row.sourceAgreement) ?? 0)));
    const best = Math.max(...scores, 0);
    const average = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
    const agreement = agreements.length ? agreements.reduce((sum, value) => sum + value, 0) / agreements.length / 3 : 0;
    const density = Math.min(1, rows.length / 4);
    return { key, rows, score: best * 0.55 + average * 0.2 + agreement * 0.15 + density * 0.1 };
  }).sort((left, right) => right.score - left.score);
  if (!multiSource) {
    const chosen = ranked[0]?.rows ?? results;
    return chosen.slice().sort((left, right) => (finiteNumber(right.qualityScore) ?? 0) - (finiteNumber(left.qualityScore) ?? 0)).slice(0, 8);
  }
  const chosenGroups = ranked.slice(0, control.maxSources);
  const chosen = chosenGroups.flatMap((group) => group.rows.slice().sort((left, right) => (finiteNumber(right.qualityScore) ?? 0) - (finiteNumber(left.qualityScore) ?? 0)).slice(0, control.maxResultsPerSource));
  return chosen.slice(0, 12);
}

export function calculateEvidenceConfidence(quality: QualitySummary, results: JsonObject[], claims: ClaimAttribution[]) {
  if (!results.length || !claims.length) return "low" as const;
  const evidenceBase = quality.evidenceStatus === "sufficient" ? 1 : quality.evidenceStatus === "weak" ? 0.55 : 0;
  const scores = results.map((result) => Math.max(0, Math.min(1, finiteNumber(result.qualityScore) ?? 0)));
  const meanQuality = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
  const agreements = results.map((result) => Math.max(0, Math.min(3, finiteNumber(result.sourceAgreement) ?? 0)));
  const modeAgreement = agreements.length ? Math.max(...agreements) / 3 : 0;
  const citationCoverage = claims.length ? Math.min(1, claims.filter((claim) => claim.citations.length > 0).length / claims.length) : 0;
  const sourceKeys = new Set(results.map((result) => `${text(result.documentId, MAX_DOCUMENT_ID_LENGTH)}|${text(result.versionId, 80)}`));
  const sourceConsistency = sourceKeys.size === 1 && results.length > 0 ? 1 : sourceKeys.size > 1 ? 0.45 : 0;
  const score = evidenceBase * 0.35 + meanQuality * 0.25 + modeAgreement * 0.2 + citationCoverage * 0.15 + sourceConsistency * 0.05;
  return score >= 0.72 ? "high" as const : score >= 0.43 ? "medium" as const : "low" as const;
}

function citationFromResult(index: number, result: JsonObject) {
  return { index, titleAr: text(result.titleAr, 500) || null, category: text(result.category, 180) || null, documentId: text(result.documentId, MAX_DOCUMENT_ID_LENGTH) || null, versionId: text(result.versionId, 80) || null, chunkId: text(result.chunkId, 240) || null, articleNumber: text(result.articleNumber, 100) || null, sectionPath: text(result.sectionPath, MAX_SCOPE_PATH_LENGTH) || null, verbatimQuote: text(result.excerpt, 3_000) || null };
}

export function evidenceScopeValidation(results: JsonObject[], input: ParsedRequest) {
  const documentIds = unique(results.map((result) => text(result.documentId, MAX_DOCUMENT_ID_LENGTH)).filter(Boolean));
  const versionIds = unique(results.map((result) => text(result.versionId, 80)).filter(Boolean));
  const sections = unique(results.map((result) => text(result.sectionPath, MAX_SCOPE_PATH_LENGTH)).filter(Boolean));
  const missingContext: string[] = [];
  if (!input.jurisdictionCode) missingContext.push("jurisdictionCode");
  if (!input.instrumentType) missingContext.push("instrumentType");
  if (!input.legalDomain) missingContext.push("legalDomain");
  if (documentIds.length > 1) missingContext.push("single_document_scope");
  if (versionIds.length > 1) missingContext.push("single_version_scope");
  return {
    requested: { jurisdictionCode: input.jurisdictionCode, instrumentType: input.instrumentType, legalDomain: input.legalDomain, documentIds: input.documentIds, versionIds: input.versionIds, unitIds: input.unitIds, sectionPaths: input.sectionPaths },
    evidence: { documentIds, versionIds, sectionPaths: sections, documentCount: documentIds.length, versionCount: versionIds.length },
    missingContext,
    requiresScopeConfirmation: missingContext.length > 0,
    generalizationPolicy: missingContext.length ? "do_not_generalize_without_scope_confirmation" : "scope_context_present",
  };
}

export function attachClaimCitations(answer: AiAnswer, results: JsonObject[], input: ParsedRequest, quality: QualitySummary) {
  const claims = answer.claims.map((claim) => ({
    ...claim,
    citations: claim.citationIndexes.map((index) => citationFromResult(index, results[index - 1] ?? {})).filter((citation) => citation.documentId || citation.chunkId),
  })).filter((claim) => claim.citations.length > 0);
  const comparisonMatrix = answer.comparisonMatrix.map((row) => ({
    ...row,
    citations: row.citationIndexes.map((index) => citationFromResult(index, results[index - 1] ?? {})).filter((citation) => citation.documentId || citation.chunkId),
  })).filter((row) => row.citations.length > 0);
  const validation = evidenceScopeValidation(results, input);
  const caveats = [...answer.caveats];
  let answerGrounding: AiAnswer["answerGrounding"] = claims.length ? "grounded" : results.length ? "unmapped" : "no_evidence";
  const sourceKeys = new Set(results.map((result) => `${text(result.documentId, MAX_DOCUMENT_ID_LENGTH)}|${text(result.versionId, 80)}`));
  const comparisonRequested = input.comparison.enabled && input.comparison.answerMode === "multi_source" && sourceKeys.size > 1;
  if (comparisonRequested && comparisonMatrix.length < 1) {
    answerGrounding = claims.length ? "partial" : "unmapped";
    caveats.push("تم استرجاع أكثر من مصدر، لكن لم تتكون مصفوفة مقارنة موثقة لكل مصدر؛ لا تعتمد على المقارنة قبل مراجعة الأدلة الأصلية.");
  }
  let confidence = calculateEvidenceConfidence(quality, results, claims);
  if (answerGrounding !== "grounded") confidence = "low";
  let answerText = answer.answer;
  if (validation.requiresScopeConfirmation) {
    if (!caveats.some((caveat) => caveat.includes("الاختصاص") || caveat.includes("الإصدار"))) caveats.push("لا يجوز تعميم هذه النتيجة قبل تثبيت الاختصاص ونوع الأداة والإصدار النافذ.");
    if (!answerText.includes("ليست قاعدة عامة") && !answerText.includes("تثبيت الاختصاص")) answerText = `تنبيه نطاقي: الأدلة التالية مستخلصة من مصدر قانوني محدد، وليست قاعدة عامة قبل تثبيت الاختصاص ونوع الأداة والإصدار النافذ.\n\n${answerText}`;
  }
  return { ...answer, answer: answerText, claims, comparisonMatrix, answerGrounding, caveats, confidence };
}

export function normalizeAnswer(value: unknown, resultCount: number, fallback: AiAnswer): AiAnswer {
  const object = asObject(value) ?? {};
  const answer = text(object.answer, 12_000);
  const caveats = textArray(object.caveats, 8, 800);
  const citationIndexes = Array.from(new Set((Array.isArray(object.citationIndexes) ? object.citationIndexes : []).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 1 && item <= resultCount)));
  const claims = Array.isArray(object.claims) ? object.claims.map((item) => {
    const claim = asObject(item);
    if (!claim) return null;
    const claimText = text(claim.claim, 1_500);
    const indexes = Array.from(new Set((Array.isArray(claim.citationIndexes) ? claim.citationIndexes : []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 1 && value <= resultCount)));
    return claimText && indexes.length ? { claim: claimText, citationIndexes: indexes, citations: [] } : null;
  }).filter((item): item is ClaimAttribution => item !== null).slice(0, 20) : [];
  const comparisonMatrix = Array.isArray(object.comparisonMatrix) ? object.comparisonMatrix.map((item) => {
    const row = asObject(item);
    if (!row) return null;
    const sourceLabel = text(row.sourceLabel ?? row.source, 500);
    const finding = text(row.finding ?? row.summary, 2_000);
    const indexes = Array.from(new Set((Array.isArray(row.citationIndexes) ? row.citationIndexes : []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 1 && value <= resultCount)));
    return sourceLabel && finding && indexes.length ? { sourceLabel, finding, citationIndexes: indexes, citations: [] } : null;
  }).filter((item): item is import("./types.ts").ComparisonAttribution => item !== null).slice(0, 6) : [];
  const confidence = object.confidence === "high" || object.confidence === "medium" || object.confidence === "low" ? object.confidence : fallback.confidence;
  return { answer: answer || fallback.answer, caveats: caveats.length ? caveats : fallback.caveats, citationIndexes, claims, comparisonMatrix, answerGrounding: claims.length ? "grounded" : resultCount ? "unmapped" : "no_evidence", confidence };
}

// فحص الأرقام: إذا ذكر الادعاء رقماً زمنياً/مقدارياً لا يظهر في أي من اقتباساته، يوسم [غير مؤكد]
function unverifiedNumbers(claim: ClaimAttribution): boolean {
  const claimText = claim.claim ?? "";
  const numbersInClaim = claimText.match(/\d+/g) ?? [];
  if (!numbersInClaim.length) return false;
  const quotes = (claim.citations ?? []).map((c) => c.verbatimQuote ?? "").join(" ");
  const normalizedQuotes = quotes.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  return numbersInClaim.some((n) => !normalizedQuotes.includes(n));
}

export function composeProfessionalNarrative(answer: AiAnswer, claims: ClaimAttribution[], validation: ReturnType<typeof evidenceScopeValidation>): { answer: string; rebuilt: boolean } {
  if (!claims.length) return { answer: answer.answer, rebuilt: false };
  const lowered = answer.answer || "";
  const hollow = lowered.length < 280 || lowered.includes("لم تتكون بعد ادعاءات") || lowered.includes("تم العثور على") || lowered.trim().endsWith(":") || lowered.trim().endsWith(":\n");
  if (!hollow) return { answer: answer.answer, rebuilt: false };
  const sections: string[] = [];
  sections.push("المبدأ:");
  sections.push("أسفر استرجاع الأدلة القانونية عن نصوص ذات صلة بالسؤال تم إسناد كل ادعاء منها بدليل مباشر. وفيما يلي العرض القانوني المهني المنهجي للحالة:");
  sections.push("");
  sections.push("التطبيق على الأدلة:");
  claims.forEach((claim, idx) => {
    const primary = claim.citations[0];
    const articleLabel = primary?.articleNumber ? `مادة ${primary.articleNumber}` : "نص مرقّم";
    const sectionLabel = primary?.sectionPath ? ` (${primary.sectionPath.split(" > ").pop()})` : "";
    const docLabel = primary?.titleAr ? ` من ${primary.titleAr}` : "";
    const quoteLine = primary?.verbatimQuote ? `نص مسند: «${primary.verbatimQuote.slice(0, 320)}».` : "";
    const unverified = unverifiedNumbers(claim) ? " [غير مؤكد رقمياً — غير ظاهر حرفياً في الاقتباس]" : "";
    sections.push(`${idx + 1}) ${claim.claim}${unverified} — ${articleLabel}${sectionLabel}${docLabel}.`);
    if (quoteLine) sections.push(quoteLine);
  });
  if (answer.comparisonMatrix.length > 1) {
    sections.push("");
    sections.push("المقارنة بين المصادر:");
    answer.comparisonMatrix.forEach((row) => {
      const cites = row.citations.map((c) => c.articleNumber ? `مادة ${c.articleNumber}` : `دليل ${c.index}`).join("، ");
      sections.push(`- ${row.sourceLabel}: ${row.finding} [${cites}]`);
    });
  }
  sections.push("");
  sections.push("خلاصة:");
  sections.push("استناداً إلى ما سبق، تتوافر أدلة مباشرة مرقّمة تغطي الجوانب الجوهرية للسؤال ضمن الوثائق والإصدارات المحددة في النتائج.");
  if (validation.requiresScopeConfirmation) {
    sections.push("");
    sections.push("تحذير نطاقي:");
    sections.push("هذه النتيجة مستخلصة من مصدر قانوني محدد، ولا يجوز تعميمها كقاعدة عامة قبل تثبيت الاختصاص ونوع الأداة والإصدار النافذ.");
  }
  return { answer: sections.join("\n"), rebuilt: true };
}

export function clampConfidenceAfterRebuild(original: AiAnswer, rebuilt: boolean): AiAnswer {
  if (!rebuilt) return original;
  if (original.confidence === "high") return { ...original, confidence: "medium" };
  return original;
}

export async function synthesizeGroundedAnswer(
  service: any,
  question: string,
  analysis: QueryAnalysis,
  results: JsonObject[],
  quality: QualitySummary,
  input: ParsedRequest,
  orchestration: OrchestrationResult | null = null,
) {
  const fallback = fallbackAnswer(quality, results.length);
  if (!results.length) return { answer: fallback, model: null };
  try {
    const evidence = results.slice(0, 8).map((result, index) => ({
      index: index + 1,
      title: text(result.titleAr, 400),
      documentId: text(result.documentId, 240),
      articleNumber: text(result.articleNumber, 100),
      sectionPath: text(result.sectionPath, 300),
      versionId: text(result.versionId, 80),
      unitId: text(result.unitId, 240),
      jurisdictionCode: text(result.jurisdictionCode, 32),
      instrumentType: text(result.instrumentType, 40),
      legalDomain: text(result.legalDomain, 120),
      excerpt: text(result.excerpt, 1_600),
      verbatimQuote: text(result.excerpt, 1_600),
      qualityScore: result.qualityScore,
      sourceAgreement: result.sourceAgreement,
    }));
    const invocation = await invokeConfiguredModel(service, {
      stage: "grounded_answer",
      question,
      instruction: "أنت محامٍ عام تستجيب لسؤال قانوني بالعربية اعتماداً حصراً على الأدلة المرقمة المرفقة. أخرج جواباً قانونياً مهنياً متكاملاً وفق البنية الإلزامية التالية، ولا تتوقف في منتصف عنصر ولا تضع عنواناً بلا مضمون: 1) تنبيه نطاقي: جملة واحدة فقط عند غياب الاختصاص أو نوع الأداة أو الإصدار. 2) المبدأ: الفكرة القانونية الأساسية في فقرة واضحة. 3) التطبيق على الأدلة: عدد من البنود المرقمة، كل بند ينقل النص المسند صراحة مع ذكر رقم المادة والمسار، ثم يربطه بالواقعة المطروحة، ثم يفصل ما يثبته النص ([نص مسند]) عن الاستنتاج المهني ([استنتاج مهني]). اربط كل بند برقم الدليل أو أكثر من citationIndexes داخل claims، ولا تضع ادعاءً موضوعياً بلا إحالة. 4) المقارنة بين المصادر (إن طُلبت): صف كل مصدر بمصدره وفحصه ثم سطر finding مع citationIndexes. 5) خلاصة: جملة واحدة مجمعة. 6) تحذير نطاقي: ما يحتاج لتثبيت (اختصاص، إصدار، نوع أداة). قيود صارمة: لا تخترع مواد أو وقائع أو خصماً غير مثبت في النص؛ إذا لم تجد نصاً كافياً قل ذلك صراحة؛ لا تستخدم أرقاماً زمنية أو مقدارية غير ظاهرة في الاقتباس؛ لا تذكر سلسلة التفكير. أعد JSON فقط بالمفاتيح: answer، caveats، citationIndexes، claims (مصفوفة من claim وcitationIndexes)، comparisonMatrix (مصفوفة من sourceLabel وfinding وcitationIndexes)، confidence (high أو medium أو low).",
      payload: { intent: analysis.intent, entities: analysis.entities, evidenceStatus: quality.evidenceStatus, scopeValidation: evidenceScopeValidation(results, input), comparison: input.comparison, orchestration, evidence },
      maxOutputTokens: 3_500,
    });
    const normalized = attachClaimCitations(normalizeAnswer(parseModelJson<unknown>(invocation.output), results.length, fallback), results, input, quality);
    if (!normalized.claims.length) {
      normalized.answer = fallback.answer;
      normalized.citationIndexes = results.length ? [1] : [];
      normalized.answerGrounding = results.length ? "unmapped" : "no_evidence";
      normalized.confidence = "low";
      normalized.caveats = [...normalized.caveats, "توجد مقتطفات مرشحة، لكن لم يتم استخراج سجل claims قابل للتحقق؛ لم تُنشأ ادعاءات جديدة تلقائيًا."];
    } else {
      const validation = evidenceScopeValidation(results, input);
      const rebuilt = composeProfessionalNarrative(normalized, normalized.claims, validation);
      if (rebuilt.rebuilt) {
        normalized.answer = rebuilt.answer;
        normalized.caveats = [...normalized.caveats, "أُعيد بناء السرد من الادعاءات الموثقة بعد أن أعاد النموذج نصاً مبتوراً، فبُنيت صياغة مهنية كاملة دون إضافة محتوى جديد."];
        normalized.confidence = clampConfidenceAfterRebuild(normalized, true).confidence;
      }
    }
    return { answer: normalized, model: { provider: invocation.provider, model: invocation.model, latencyMs: invocation.latencyMs, usage: invocation.usage } };
  } catch (error) {
    console.warn("kimo grounded answer fallback", error instanceof Error ? error.message : "AI_ANSWER_FAILED");
    return { answer: fallback, model: null };
  }
}