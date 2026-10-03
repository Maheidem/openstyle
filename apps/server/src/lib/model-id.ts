/**
 * Remove a leading "<providerId>/" from a model id.
 * Return the id unchanged when the prefix is absent.
 */
export function stripModelPrefix(providerId: string, modelId: string): string {
  const prefix = `${providerId}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}
