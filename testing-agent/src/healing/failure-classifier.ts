import type { TestRunResult } from '../browser/test-runner.js';

export type PreClassification = 'possible-ui-change' | 'assertion-mismatch' | 'environment' | 'unknown';

export interface FailureAnalysis {
  category: PreClassification;
  /** Whether it is worth asking the agent at all. Environment failures never are. */
  worthInvestigating: boolean;
  evidence: string[];
}

const ENVIRONMENT = [
  /ERR_CONNECTION_REFUSED/,
  /ECONNREFUSED/,
  /ERR_NAME_NOT_RESOLVED/,
  /Executable doesn't exist/,
  /browserType\.launch/,
  /Playwright produced no JSON report/,
];

const LOCATOR = [
  /waiting for (getBy\w+|locator)\(/,
  /element\(s\) not found/,
  /strict mode violation/,
  /resolved to 0 elements/,
  /Timeout \d+ms exceeded/,
  /locator\.(click|fill|check|selectOption|press|hover)/,
];

const ASSERTION_VALUE = [/\bExpected\b[^\n]*:/, /\bReceived\b[^\n]*:/];

/**
 * Cheap, deterministic triage before any AI call. It only *suggests* a category; the agent makes the
 * final classification, and a regression is never "fixed" by editing the test.
 */
export function classifyFailure(result: TestRunResult): FailureAnalysis {
  const text = [...result.failures.map((f) => `${f.message}\n${f.stack ?? ''}`), result.rawOutputTail].join('\n');
  const evidence: string[] = [];

  for (const pattern of ENVIRONMENT) {
    if (pattern.test(text)) {
      evidence.push(`matched environment signal ${pattern}`);
      return { category: 'environment', worthInvestigating: false, evidence };
    }
  }
  const locatorHits = LOCATOR.filter((p) => p.test(text));
  // Playwright logs "waiting for <locator>" even when the element exists; "resolved to <element>" or
  // "unexpected value" prove it was found and only its value/state differed.
  const elementFound = /locator resolved to <|unexpected value/.test(text);
  const notFound = /element\(s\) not found|resolved to 0 elements/.test(text) || (!elementFound && locatorHits.length > 0);
  const valueMismatch = ASSERTION_VALUE.every((p) => p.test(text)) && elementFound && !notFound;

  if (valueMismatch) {
    evidence.push('assertion compared different values (element was found)');
    return { category: 'assertion-mismatch', worthInvestigating: true, evidence };
  }
  if (locatorHits.length) {
    evidence.push(...locatorHits.map((p) => `matched locator signal ${p}`));
    return { category: 'possible-ui-change', worthInvestigating: true, evidence };
  }
  return { category: 'unknown', worthInvestigating: true, evidence: ['no known signature'] };
}
