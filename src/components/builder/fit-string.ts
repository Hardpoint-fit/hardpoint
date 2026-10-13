// Fit strings as players paste them. Chat wraps long lines and adds spaces, so every whitespace
// character is dropped before the engine is asked (the engine does the same; FitString.TryDecode).
// Whether the rest is a fit string is the engine's call.
export function normalizeFitString(text: string): string {
  return text.replace(/\s+/g, "");
}
