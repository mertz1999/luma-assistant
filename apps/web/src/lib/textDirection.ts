/** Detect whether text should render RTL (Farsi/Arabic/Hebrew). */

const RTL_SCRIPT = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR_SCRIPT = /[A-Za-z\u00C0-\u024F]/;

function keepIfHasRtl(inner: string): string {
  return RTL_SCRIPT.test(inner) ? inner : " ";
}

/**
 * Strip tokens that should not drive chat direction.
 * Farsi technical replies often open with paths, filenames, English product labels,
 * and quoted English specs; those Latin characters otherwise flip the heuristic to LTR.
 */
function stripDirectionNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, (_match, inner: string) => keepIfHasRtl(inner))
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_match, inner: string) => keepIfHasRtl(inner))
    .replace(/^>\s*.+$/gm, " ")
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
    if (rtl + ltr >= 128) break;
  }
  if (rtl === 0 && ltr === 0) return "ltr";
  if (rtl === 0) return "ltr";
  // Prefer RTL for mixed Farsi/English technical prose unless Latin clearly dominates.
  if (ltr > rtl * 2) return "ltr";
  return "rtl";
}

export function hasRtlScript(text: string): boolean {
  return RTL_SCRIPT.test(text);
}
