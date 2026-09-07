/** Detect whether text should render RTL (Farsi/Arabic/Hebrew). */

const RTL_SCRIPT = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR_SCRIPT = /[A-Za-z\u00C0-\u024F]/;

/**
 * Strip tokens that should not drive chat direction.
 * Farsi technical replies often open with paths, filenames, and inline code;
 * those Latin characters otherwise flip the heuristic to LTR and drop Vazirmatn.
 */
function stripDirectionNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\b[\w.+@-]+\/[\w./_+@-]+/g, " ")
    .replace(/\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|md|json|ya?ml|css|html|vue|svelte)\b/gi, " ");
}

export type TextDirection = "rtl" | "ltr";

export function resolveTextDirection(text: string): TextDirection {
  const sample = stripDirectionNoise(text);
  let rtl = 0;
  let ltr = 0;
  for (const char of sample) {
    if (RTL_SCRIPT.test(char)) rtl += 1;
    else if (LTR_SCRIPT.test(char)) ltr += 1;
    if (rtl + ltr >= 96) break;
  }
  if (rtl === 0 && ltr === 0) return "ltr";
  return rtl >= ltr ? "rtl" : "ltr";
}

export function hasRtlScript(text: string): boolean {
  return RTL_SCRIPT.test(text);
}
