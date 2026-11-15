import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRequirement } from '../../src/business-knowledge/business-knowledge-provider.js';
import { LocalBusinessKnowledgeProvider } from '../../src/business-knowledge/local-business-knowledge-provider.js';
import { resolvePaths } from '../../src/config/config.js';
import { businessContextSections } from '../../src/generator/prompts.js';

const realProvider = new LocalBusinessKnowledgeProvider(resolvePaths().businessContext);

describe('business knowledge retrieval', () => {
  it('retrieves a requirement by its stable id with acceptance criteria and source', async () => {
    const context = await realProvider.getRelevantContext({ appId: 'bulletproof-react', requirementIds: ['REQ-001'] });
    expect(context.requirements.map((r) => r.id)).toEqual(['REQ-001']);
    expect(context.retrieval.matchedBy).toEqual({ 'REQ-001': 'explicit-id' });
    const req = context.requirements[0]!;
    expect(req.acceptanceCriteria.map((ac) => ac.id)).toEqual(['AC-1', 'AC-2']);
    expect(req.source.document).toMatch(/Business Requirements Specification/);
    expect(context.documents[0]?.source).toBe('business-context/bulletproof-react/domain-overview.md');
  });

  it('matches requirements from a free-text objective', async () => {
    const context = await realProvider.getRelevantContext({ appId: 'bulletproof-react', objective: 'Check that regular users cannot see the users directory (admin only, privacy)' });
    expect(context.requirements[0]?.id).toBe('REQ-002');
    expect(context.retrieval.strategy).toBe('keyword-overlap');
  });

  it('returns nothing for unrelated objectives or unknown apps', async () => {
    expect((await realProvider.getRelevantContext({ appId: 'bulletproof-react', objective: 'zzz qqq' })).requirements).toEqual([]);
    expect((await realProvider.getRelevantContext({ appId: 'unknown-app', requirementIds: ['REQ-001'] })).requirements).toEqual([]);
    expect(await realProvider.getRequirement('bulletproof-react', 'REQ-404')).toBeUndefined();
  });

  it('rejects malformed requirement files and duplicate ids', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'biz-'));
    mkdirSync(path.join(root, 'demo'));
    writeFileSync(path.join(root, 'demo', 'a.json'), JSON.stringify({ appId: 'demo', requirements: [{ id: 'BAD', appId: 'demo' }] }));
    expect(() => new LocalBusinessKnowledgeProvider(root).loadRequirements('demo')).toThrow(/Invalid requirements file/);
    expect(() => new LocalBusinessKnowledgeProvider(root).loadRequirements('../etc')).toThrow(/Invalid appId/);
  });

  it('is injected into prompts as untrusted data', async () => {
    const context = await realProvider.getRelevantContext({ appId: 'bulletproof-react', requirementIds: ['REQ-001'] });
    const sections = businessContextSections(context);
    expect(sections.every((s) => s.trusted === false)).toBe(true);
    expect(sections[0]?.content).toContain('AC-1: GIVEN');
    expect(formatRequirement(context.requirements[0]!)).toContain('REQ-001: Only team administrators may start new discussions');
  });
});
