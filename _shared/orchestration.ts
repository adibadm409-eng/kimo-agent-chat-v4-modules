import { invokeConfiguredModel, parseModelJson } from "./ai-provider.ts";
import { searchLegalKnowledge } from "./legal-knowledge-search.ts";
import type { QualitySummary } from "./answer-synthesis.ts";
import type { JsonObject, OrchestrationResult, ParsedRequest, QueryAnalysis, WorkerClaim, WorkerResult, WorkerRole } from "./types.ts";
import { MAX_DOCUMENT_ID_LENGTH, MAX_SCOPE_PATH_LENGTH, asObject, text, textArray } from "./utils.ts";
import { enrichResultIdentity } from "./candidates.ts";

function orchestrationEvidence(results: JsonObject[]) {
  return results.slice(0, 12).map((result, index) => ({
    index: index + 1,
    documentId: text(result.documentId, MAX_DOCUMENT_ID_LENGTH),
    versionId: text(result.versionId, 80),
    chunkId: text(result.chunkId, 240),
    unitId: text(result.unitId, 240),
    articleNumber: text(result.articleNumber, 100),
    sectionPath: text(result.sectionPath, MAX_SCOPE_PATH_LENGTH),
    titleAr: text(result.titleAr, 400),
    excerpt: text(result.excerpt, 1_600),
    qualityScore: result.qualityScore,
    sourceAgreement: result.sourceAgreement,
  }));
}

function normalizeWorkerOutput(value: unknown, role: WorkerRole, resultCount: number, sourceRefs: JsonObject[], latencyMs: number, model: { provider: string; model: string } | null): WorkerResult {
  const object = asObject(value) ?? {};
  const claims = Array.isArray(object.claims) ? object.claims.map((item) => {
    const row = asObject(item);
    if (!row) return null;
    const claim = text(row.claim, 1_500);
    const citationIndexes = Array.from(new Set((Array.isArray(row.citationIndexes) ? row.citationIndexes : []).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 1 && item <= resultCount)));
    const supportLevel = row.supportLevel === "direct" || row.supportLevel === "inference" ? row.supportLevel : "unverified";
    return claim && citationIndexes.length ? { claim, citationIndexes, supportLevel } : null;
  }).filter((item): item is WorkerClaim => item !== null).slice(0, 8) : [];
  return {
    role,
    status: "completed",
    claims,
    conflicts: textArray(object.conflicts, 6, 700),
    limitations: textArray(object.limitations, 6, 700),
    sourceRefs,
    latencyMs,
    model,
  };
}

export async function runOrchestration(
  service: any,
  question: string,
  analysis: QueryAnalysis,
  results: JsonObject[],
  quality: QualitySummary,
  input: ParsedRequest,
): Promise<OrchestrationResult | null> {
  const control = input.orchestration;
  if (!control.enabled || control.mode === "single") return null;
  const sourceCount = new Set(results.map((result) => `${text(result.documentId, MAX_DOCUMENT_ID_LENGTH)}|${text(result.versionId, 80)}`)).size;
  const adaptiveNeedsWorkers = analysis.articleNumbers.length > 0 || quality.evidenceStatus !== "sufficient" || input.comparison.enabled;
  if (control.mode === "adaptive" && !adaptiveNeedsWorkers) return { enabled: true, mode: control.mode, workers: [], arbitration: { status: "convergent", completedWorkerCount: 0, conflictCount: 0, validWorkerClaimCount: 0, policy: "adaptive_mode_kept_single_agent_path_for_clear_single_source_evidence" } };
  const roles: WorkerRole[] = control.mode === "deep_review"
    ? ["retrieval", "article_verification", "critical_review"]
    : ["retrieval", "article_verification", "critical_review"].slice(0, control.maxWorkers) as WorkerRole[];
  const evidence = orchestrationEvidence(results);
  const roleInstructions: Record<WorkerRole, string> = {
    retrieval: "راجع اكتمال تغطية الأدلة الحالية للسؤال. لا تنشئ مصادر أو claims جديدة بلا citationIndexes. حدد فقط ما تدعمه الأدلة وما بقي غير مغطى.",
    article_verification: "تحقق من أرقام المواد والصياغة الرسمية. إذا لم يوجد رقم مادة في السؤال، قيّم هوية المادة/المسار إن أمكن. لا تعتبر التشابه النصي تطابقًا مباشرًا، وأبلغ عن عدم المطابقة صراحة.",
    critical_review: "اعمل كناقد قانوني مستقل: ابحث عن تعارض بين الوثائق والإصدارات، والاستثناءات، وخطر التعميم، وأي claim لا يثبته الاقتباس مباشرة.",
  };
  const runWorker = async (role: WorkerRole): Promise<WorkerResult> => {
    if (role === "article_verification" && (!analysis.articleNumbers.length || !analysis.lawSpecified)) return { role, status: "skipped", claims: [], conflicts: [], limitations: [!analysis.articleNumbers.length ? "لا يوجد رقم مادة صريح في السؤال." : "رقم المادة موجود لكن القانون غير محدد — لا يصح التحقق من مادة قبل تثبيت قانونها."], sourceRefs: [], latencyMs: 0, model: null };
    const startedAt = Date.now();
    try {
      let workerEvidence = evidence;
      let sourceRefs: JsonObject[] = [];
      if (role === "retrieval") {
        // إعادة استخدام نتائج البحث الرئيسية كمرجع فوري؛ بحث العامل يجري بحد 6 ثوانٍ فقط وإلا نستخدم النتائج الجاهزة
        const fallbackRefs = results.slice(0, 6).map((row) => ({
          documentId: text(row.documentId, MAX_DOCUMENT_ID_LENGTH) || null,
          versionId: text(row.versionId, 80) || null,
          chunkId: text(row.chunkId, 240) || null,
          unitId: text(row.unitId, 240) || null,
          articleNumber: text(row.articleNumber, 100) || null,
          sectionPath: text(row.sectionPath, MAX_SCOPE_PATH_LENGTH) || null,
          titleAr: text(row.titleAr, 400) || null,
          verbatimQuote: text(row.excerpt, 1_600) || null,
        }));
        const workerSearchPromise = (async () => {
          const workerSearch = await searchLegalKnowledge(service, {
            query: analysis.alternativeQuery || analysis.canonicalQuery,
            mode: "hybrid",
            matchCount: Math.min(6, Math.max(3, input.topK)),
            matchThreshold: input.matchThreshold,
            jurisdictionCode: input.jurisdictionCode,
            instrumentType: input.instrumentType,
            legalDomain: input.legalDomain,
            documentIds: input.documentIds,
            includeNonActive: false,
          useContextual: input.useContextualEmbeddings,
            idempotencyKey: `${input.idempotencyKey}:worker-retrieval`,
            queryEmbedding: null,
            profileKey: input.searchSkill.enabled ? input.searchSkill.profileKey : null,
            profileOwner: input.searchSkill.enabled ? input.searchSkill.profileOwner : null,
          });
          const workerRows = await enrichResultIdentity(service, (workerSearch.results ?? []) as JsonObject[]);
          return workerRows.slice(0, 6).map((row) => ({
            documentId: text(row.document_id, MAX_DOCUMENT_ID_LENGTH) || null,
            versionId: text(row.version_id, 80) || null,
            chunkId: text(row.chunk_id, 240) || null,
            unitId: text(row.unit_id, 240) || null,
            articleNumber: text(row.article_number, 100) || null,
            sectionPath: text(row.section_path, MAX_SCOPE_PATH_LENGTH) || null,
            titleAr: text(row.title_ar, 400) || null,
            verbatimQuote: text(row.excerpt, 1_600) || null,
          }));
        })();
        sourceRefs = await Promise.race([
          workerSearchPromise.catch(() => fallbackRefs),
          new Promise((resolve) => setTimeout(() => resolve(fallbackRefs), 6_000)),
        ]) as JsonObject[];
        workerEvidence = [...evidence, ...sourceRefs.map((row, index) => ({ ...row, index: evidence.length + index + 1, excerpt: row.verbatimQuote }))];
      }
      const invocation = await invokeConfiguredModel(service, {
        stage: `subagent_${role}`,
        question,
        instruction: `${roleInstructions[role]} أعد JSON فقط بالمفاتيح: claims (كل عنصر claim وcitationIndexes وsupportLevel)، conflicts، limitations. استخدم أرقام الأدلة المرفقة فقط. لا تذكر سلسلة التفكير الداخلية.`,
        payload: { intent: analysis.intent, articleNumbers: analysis.articleNumbers, evidenceStatus: quality.evidenceStatus, evidence: workerEvidence, sourceRefs },
        maxOutputTokens: 1_000,
        timeoutMs: control.timeoutMs,
      });
      return normalizeWorkerOutput(parseModelJson<unknown>(invocation.output), role, workerEvidence.length, sourceRefs, Date.now() - startedAt, { provider: invocation.provider, model: invocation.model });
    } catch (error) {
      return { role, status: "failed", claims: [], conflicts: [], limitations: [], sourceRefs: [], latencyMs: Date.now() - startedAt, model: null, error: error instanceof Error ? error.message : "WORKER_FAILED" };
    }
  };
  const workers = await Promise.all(roles.map(runWorker));
  const completed = workers.filter((worker) => worker.status === "completed").length;
  const conflictCount = workers.reduce((sum, worker) => sum + worker.conflicts.length, 0);
  const validWorkerClaimCount = workers.reduce((sum, worker) => sum + worker.claims.length, 0);
  const status = conflictCount > 0 ? "review_required" : completed >= 2 && validWorkerClaimCount > 0 ? "convergent" : "insufficient_worker_agreement";
  return {
    enabled: true,
    mode: control.mode,
    workers,
    arbitration: { status, completedWorkerCount: completed, conflictCount, validWorkerClaimCount, policy: "workers_are_audit_signals_only;_the_main_agent_retains_final_citation_and_scope_authority" },
  };
}