/* What is wrong with the settings of the link to Sarthi; on but incomplete = the server does not start. */
interface LinkSettings {
  NODE_ENV: string;
  SARTHI_LINK_ENABLED: boolean;
  SARTHI_API_URL?: string;
  SARTHI_LINK_SECRET?: string;
}
const LOCAL = ['localhost', '127.0.0.1', '[::1]'];

export function linkProblems(s: LinkSettings): string[] {
  const problems: string[] = [];
  if (s.SARTHI_LINK_ENABLED && (!s.SARTHI_API_URL || !s.SARTHI_LINK_SECRET))
    problems.push('SARTHI_LINK_ENABLED=true needs SARTHI_API_URL and SARTHI_LINK_SECRET');
  if (s.SARTHI_API_URL) {
    const url = new URL(s.SARTHI_API_URL);
    /* The path is part of every signature: nothing may be put in front of it. */
    if (url.pathname !== '/' || url.search || url.hash)
      problems.push('SARTHI_API_URL must be an address without a path, e.g. https://api.example.org');
    if (['staging', 'production'].includes(s.NODE_ENV) && url.protocol !== 'https:' && !LOCAL.includes(url.hostname))
      problems.push('SARTHI_API_URL must be https');
  }
  return problems;
}
