import { z } from 'zod';

/**
 * Business knowledge is retrieved through this interface only. Implementations may read local files
 * (this POC), call a requirements-management system, or query a RAG index — the orchestrator does not care.
 * Everything returned is treated as UNTRUSTED data when it is placed into an agent prompt.
 */

export const AcceptanceCriterionSchema = z.object({
  id: z.string().regex(/^AC-\d+$/),
  given: z.string(),
  when: z.string(),
  then: z.string(),
});

export const BusinessRequirementSchema = z.object({
  id: z.string().regex(/^REQ-\d{3,}$/, 'Requirement ids must look like REQ-001'),
  appId: z.string(),
  title: z.string(),
  type: z.enum(['business-rule', 'user-story', 'functional-spec', 'permission']).default('business-rule'),
  description: z.string(),
  roles: z.array(z.string()).default([]),
  businessRules: z.array(z.string()).default([]),
  workflow: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  expectedOutcomes: z.array(z.string()).default([]),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  tags: z.array(z.string()).default([]),
  source: z.object({ document: z.string(), section: z.string().optional(), version: z.string().optional() }),
});

export const RequirementsFileSchema = z.object({
  appId: z.string(),
  requirements: z.array(BusinessRequirementSchema),
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type BusinessRequirement = z.infer<typeof BusinessRequirementSchema>;

export interface BusinessContextRequest {
  appId: string;
  /** Explicit requirement ids take precedence over free-text matching. */
  requirementIds?: string[];
  objective?: string;
  maxResults?: number;
}

export interface BusinessDocumentExcerpt {
  source: string;
  content: string;
}

export interface BusinessContextResult {
  appId: string;
  provider: string;
  requirements: BusinessRequirement[];
  /** Supporting domain documentation (e.g. glossary, role descriptions). */
  documents: BusinessDocumentExcerpt[];
  retrieval: { strategy: string; matchedBy: Record<string, string> };
}

export interface BusinessKnowledgeProvider {
  readonly name: string;
  getRelevantContext(request: BusinessContextRequest): Promise<BusinessContextResult>;
  getRequirement(appId: string, requirementId: string): Promise<BusinessRequirement | undefined>;
}

export class RequirementNotFoundError extends Error {
  constructor(appId: string, id: string) {
    super(`Requirement ${id} was not found for application ${appId}`);
    this.name = 'RequirementNotFoundError';
  }
}

export function formatRequirement(req: BusinessRequirement): string {
  return [
    `${req.id}: ${req.title} [${req.type}, priority ${req.priority}]`,
    `Source: ${req.source.document}${req.source.section ? ` §${req.source.section}` : ''}${req.source.version ? ` (v${req.source.version})` : ''}`,
    `Description: ${req.description}`,
    req.roles.length ? `Roles: ${req.roles.join(', ')}` : '',
    req.businessRules.length ? `Business rules:\n${req.businessRules.map((r) => `- ${r}`).join('\n')}` : '',
    req.workflow.length ? `Workflow:\n${req.workflow.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
    `Acceptance criteria:\n${req.acceptanceCriteria.map((ac) => `- ${ac.id}: GIVEN ${ac.given} WHEN ${ac.when} THEN ${ac.then}`).join('\n')}`,
    req.expectedOutcomes.length ? `Expected outcomes:\n${req.expectedOutcomes.map((o) => `- ${o}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
