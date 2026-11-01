// Browser engines differ in whether stacks contain the message. AggregateError
// and cause also need explicit traversal before structured cloning to the runner.
export function describeBrowserError(error) {
  const seen = new Set();
  const describe = (value, depth) => {
    if (depth > 8) return '[Error nesting limit]';
    if (!value || typeof value !== 'object') return String(value).slice(0, 8000);
    if (seen.has(value)) return '[Repeated error]';
    seen.add(value);
    const parts = [String(value).slice(0, 8000)];
    if (value.stack) parts.push(String(value.stack).split('\n').slice(0, 12)
      .map(line => line.slice(0, 1000)).join('\n'));
    if (value.cause !== undefined) parts.push(`Caused by: ${describe(value.cause, depth + 1)}`);
    if (Array.isArray(value.errors)) {
      value.errors.slice(0, 50).forEach((nested, index) => {
        parts.push(`Failure ${index + 1}: ${describe(nested, depth + 1)}`);
      });
      if (value.errors.length > 50) parts.push(`[${value.errors.length - 50} additional errors omitted]`);
    }
    return parts.join('\n');
  };
  return describe(error, 0).slice(0, 100000);
}
