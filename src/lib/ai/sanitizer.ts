// ─── Identity Masking Output Filter ──────────────────────────────────────────
// Catches any accidental leaks of the underlying AI model identity and replaces
// them with The Fixer branding before responses reach the user.

const REPLACEMENT_MAP: [RegExp, string][] = [
  // Direct model / company names (case-insensitive, word boundary)
  [/\bClaude\b/gi, "The Fixer"],
  [/\bAnthropic\b/gi, "Bricks"],
  [/\bOpenAI\b/gi, "Bricks"],
  [/\bGPT[-\s]?\d*\b/gi, "The Fixer"],
  [/\bChatGPT\b/gi, "The Fixer"],
  [/\bGemini\b/gi, "The Fixer"],
  [/\bLLaMA\b/gi, "The Fixer"],
  [/\bMistral\b/gi, "The Fixer"],

  // Model variant names
  [/\b(?:opus|sonnet|haiku)(?:\s*[\d.]+)?\b/gi, "The Fixer"],

  // Self-identification phrases
  [/I(?:'m| am) (?:a |an )?(?:AI |artificial intelligence |language )?(?:model|assistant|chatbot|LLM)(?:\s+(?:made|created|built|developed|trained)\s+by\s+\w+)?/gi,
    "I'm The Fixer, built by the Bricks team"],
  [/(?:made|created|built|developed|trained)\s+by\s+(?:Anthropic|OpenAI|Google|Meta)/gi,
    "built by the Bricks team"],
  [/(?:I(?:'m| am) )?(?:based on|powered by)\s+(?:Claude|GPT|Gemini|LLaMA|Mistral)[\w\s.-]*/gi,
    "I'm The Fixer"],

  // "As an AI" style phrasing
  [/[Aa]s an AI(?:\s+(?:language\s+)?model)?/g, "As The Fixer"],
];

/**
 * Sanitize a complete text response — removes all identity leaks.
 */
export function sanitizeResponse(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REPLACEMENT_MAP) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Buffer-aware sanitizer for streaming chunks.
 *
 * Because tokens can be split across chunk boundaries (e.g. "Clau" | "de"),
 * we keep a rolling buffer of the last 20 characters. Each call returns the
 * safe-to-emit portion and updates the buffer in place.
 */
export function sanitizeStreamChunk(
  chunk: string,
  buffer: { value: string }
): string {
  const combined = buffer.value + chunk;

  // Keep the last 20 chars in the buffer to catch split tokens
  const BUFFER_SIZE = 20;

  if (combined.length <= BUFFER_SIZE) {
    buffer.value = combined;
    return "";
  }

  const safeRegion = combined.slice(0, combined.length - BUFFER_SIZE);
  buffer.value = combined.slice(combined.length - BUFFER_SIZE);

  return sanitizeResponse(safeRegion);
}

/**
 * Flush the remaining buffer content at the end of a stream.
 */
export function flushBuffer(buffer: { value: string }): string {
  const remaining = sanitizeResponse(buffer.value);
  buffer.value = "";
  return remaining;
}
