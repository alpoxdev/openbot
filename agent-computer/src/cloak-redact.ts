/**
 * Strip proxy credentials from a string that may be shown to a model or logged.
 *
 * Cloak can put a proxy URL on argv. A launch error that echoed that argv would
 * otherwise hand a password to whoever reads the computer's JSON.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\/\/([^/@\s:]+):([^/@\s]+)@/g, "//***:***@")
    .replace(/password=([^\s&"'\\]+)/gi, "password=***");
}
