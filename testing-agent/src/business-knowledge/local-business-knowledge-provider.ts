import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeObjective } from '../knowledge/test-matcher.js';
import {
  RequirementsFileSchema,
  type BusinessContextRequest,
  type BusinessContextResult,
  type BusinessDocumentExcerpt,
  type BusinessKnowledgeProvider,
  type BusinessRequirement,
} from './business-knowledge-provider.js';

const MAX_DOC_CHARS = 6_000;

/**
 * Reads business-context/<appId>/*.json (structured requirements) and *.md (domain documentation).
 * Retrieval is deliberately simple: explicit ids first, then keyword overlap. A RAG-backed provider
 * can replace this class without touching the orchestrator.
 */
export class LocalBusinessKnowledgeProvider implements BusinessKnowledgeProvider {
  readonly name = 'local-files';

  constructor(private readonly rootDir: string) {}

  private appDir(appId: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(appId)) throw new Error(`Invalid appId ${appId}`);
    return path.join(this.rootDir, appId);
  }

  loadRequirements(appId: string): BusinessRequirement[] {
    const dir = this.appDir(appId);
    if (!existsSync(dir)) return [];
    const requirements: BusinessRequirement[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const parsed = RequirementsFileSchema.safeParse(JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
      if (!parsed.success) {
        throw new Error(`Invalid requirements file ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      }
      requirements.push(...parsed.data.requirements.filter((r) => r.appId === appId));
    }
    const ids = new Set<string>();
    for (const req of requirements) {
      if (ids.has(req.id)) throw new Error(`Duplicate requirement id ${req.id} for ${appId}`);
      ids.add(req.id);
    }
    return requirements;
  }

  private loadDocuments(appId: string): BusinessDocumentExcerpt[] {
    const dir = this.appDir(appId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((file) => ({ source: `business-context/${appId}/${file}`, content: readFileSync(path.join(dir, file), 'utf8').slice(0, MAX_DOC_CHARS) }));
  }

  async getRequirement(appId: string, requirementId: string): Promise<BusinessRequirement | undefined> {
    return this.loadRequirements(appId).find((r) => r.id === requirementId);
  }

  async getRelevantContext(request: BusinessContextRequest): Promise<BusinessContextResult> {
    const all = this.loadRequirements(request.appId);
    const matchedBy: Record<string, string> = {};
    let selected: BusinessRequirement[] = [];

    if (request.requirementIds?.length) {
      selected = all.filter((r) => request.requirementIds!.includes(r.id));
      for (const r of selected) matchedBy[r.id] = 'explicit-id';
    } else if (request.objective) {
      const words = new Set(normalizeObjective(request.objective).split(' ').filter((w) => w.length > 2));
      selected = all
        .map((req) => {
          const haystack = normalizeObjective([req.title, req.description, ...req.tags, ...req.businessRules].join(' '));
          const score = haystack.split(' ').filter((w) => words.has(w)).length;
          return { req, score };
        })
        .filter((entry) => entry.score >= 2)
        .sort((a, b) => b.score - a.score)
        .map((entry) => {
          matchedBy[entry.req.id] = `keyword-overlap:${entry.score}`;
          return entry.req;
        });
    }

    return {
      appId: request.appId,
      provider: this.name,
      requirements: selected.slice(0, request.maxResults ?? 3),
      documents: selected.length ? this.loadDocuments(request.appId) : [],
      retrieval: { strategy: request.requirementIds?.length ? 'explicit-id' : 'keyword-overlap', matchedBy },
    };
  }
}
