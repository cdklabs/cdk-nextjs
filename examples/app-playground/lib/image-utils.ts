/**
 * Helper to conditionally prefix image src paths for API Gateway deployments.
 *
 * For CloudFront deployments: Returns the path as-is
 * For API Gateway deployments: Prefixes with stage name (e.g., /prod)
 *
 * Usage:
 * ```tsx
 * <Image src={getImageSrc('/static/image.jpg')} ... />
 * ```
 */
export function getImageSrc(path: string): string {
  const prefix = process.env.NEXT_PUBLIC_IMAGE_SRC_PREFIX;

  if (!prefix) {
    return path;
  }

  // Avoid double-prefixing
  if (path.startsWith(prefix)) {
    return path;
  }

  return `${prefix}${path}`;
}
