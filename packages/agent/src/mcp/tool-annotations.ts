import type { McpToolAnnotations } from '../lib/tool-types.js';

/**
 * A new object with the five standard hints that are defined, and nothing
 * else. Every path that puts annotations on a tool or in a snapshot goes
 * through it, so an unknown key never reaches either, an absent hint stays
 * absent, and no two of them share an object.
 */
export function copyToolAnnotations(
  reported: {
    readonly [K in keyof McpToolAnnotations]?: McpToolAnnotations[K] | undefined;
  },
): McpToolAnnotations {
  return {
    ...(reported.title !== undefined && {
      title: reported.title,
    }),
    ...(reported.readOnlyHint !== undefined && {
      readOnlyHint: reported.readOnlyHint,
    }),
    ...(reported.destructiveHint !== undefined && {
      destructiveHint: reported.destructiveHint,
    }),
    ...(reported.idempotentHint !== undefined && {
      idempotentHint: reported.idempotentHint,
    }),
    ...(reported.openWorldHint !== undefined && {
      openWorldHint: reported.openWorldHint,
    }),
  };
}
