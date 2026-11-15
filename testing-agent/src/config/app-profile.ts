import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Application profile: the only place where application-specific *technical* facts live.
 * Business requirements live in business-context/, learned facts in knowledge/.
 */
export const AppProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().default(''),
  sourceRepository: z
    .object({ url: z.string().url(), commit: z.string().optional(), license: z.string().optional() })
    .optional(),
  /** Entry path relative to the base URL, e.g. "/". */
  entryPath: z.string().default('/'),
  /** How tests obtain users/data. Free text handed to the agent as technical context. */
  testDataStrategy: z.string().default(''),
  /** Additional technical hints (never credentials). */
  technicalNotes: z.array(z.string()).default([]),
});

export type AppProfile = z.infer<typeof AppProfileSchema>;

export function loadAppProfile(profilesDir: string, appId: string): AppProfile {
  const file = path.join(profilesDir, `${appId}.json`);
  if (!existsSync(file)) {
    return AppProfileSchema.parse({ id: appId, name: appId });
  }
  return AppProfileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
