/**
 * Renders a route's resolved params as JSON so an e2e can assert on values
 * rather than on prose. Every routing edge case in `app/params/**` uses this, so
 * there is one shape to parse and one `data-testid` to find.
 *
 * Deliberately `JSON.stringify` of the whole object, not a per-key render: the
 * bugs this exists for are extra keys and phantom segments, and a template that
 * only prints the keys it expects cannot see either.
 */
export function ParamsDump({ params }: { params: Record<string, unknown> }) {
  return (
    <pre data-testid="params" className="text-sm text-gray-200">
      {JSON.stringify(params)}
    </pre>
  );
}
