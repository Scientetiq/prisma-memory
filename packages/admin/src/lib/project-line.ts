// The workplace writes this line, and the MCP instructions and memory skill quote it.
export const PROJECT_LINE_PREFIX = "Project memory: space ";

export function formatProjectLine(slug: string): string {
  return `${PROJECT_LINE_PREFIX}${slug}`;
}
