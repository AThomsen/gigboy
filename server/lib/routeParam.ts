/**
 * Reads a named route parameter (`:bandId`, `:id`, ...).
 *
 * Express 5's types widen every param to `string | string[]` because `*splat`
 * wildcards yield arrays. Named params are always strings at runtime, and this
 * app reads no wildcard params, so the narrowing is safe. Needed where TypeScript
 * can't infer params from the route string: shared helpers taking a plain
 * `Request`, and params inherited from a parent router via `mergeParams`.
 */
export function param(req: { params: object }, name: string): string {
  return (req.params as Record<string, string>)[name];
}
