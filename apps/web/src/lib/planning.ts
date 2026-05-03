export type PlanningSegment =
  | { type: "markdown"; text: string }
  | { type: "question"; raw: string; title: string; description: string; options: string[] }
  | { type: "proposed_plan"; text: string }
  | { type: "final_approval"; text: string };

type TaggedSegment = {
  type: "question" | "proposed_plan" | "final_approval";
  body: string;
};

const planningTagPattern = /<(question|proposed_plan|final_approval)>([\s\S]*?)<\/\1>/gi;

function normalizeText(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

function toMarkdownSegment(text: string): PlanningSegment | null {
  if (!text.trim()) return null;
  return { type: "markdown", text };
}

function stripMarkdownHeading(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

function parseTaggedSegment(tagged: TaggedSegment): PlanningSegment {
  const body = normalizeText(tagged.body).trim();

  if (tagged.type === "proposed_plan") {
    return { type: "proposed_plan", text: body };
  }

  if (tagged.type === "final_approval") {
    return { type: "final_approval", text: body };
  }

  const lines = body.split("\n");
  const optionLines: string[] = [];
  const contentLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      contentLines.push("");
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/) || line.match(/^\d+\.\s+(.+)$/);
    if (bulletMatch) {
      optionLines.push(bulletMatch[1].trim());
      continue;
    }

    contentLines.push(rawLine);
  }

  if (optionLines.length === 0) {
    return { type: "markdown", text: body };
  }

  const normalizedContent = contentLines.map((line) => line.trimEnd()).join("\n").trim();
  const nonEmptyContentLines = normalizedContent
    ? normalizedContent.split("\n").map((line) => line.trim()).filter(Boolean)
    : [];

  const titleLine = nonEmptyContentLines[0] || "Question";
  const title = stripMarkdownHeading(titleLine) || "Question";
  const description = nonEmptyContentLines
    .slice(1)
    .join("\n")
    .trim();

  return {
    type: "question",
    raw: body,
    title,
    description,
    options: optionLines,
  };
}

export function parsePlanningMessage(input: string): PlanningSegment[] {
  const text = normalizeText(input);
  const parsedSegments: PlanningSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = planningTagPattern.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    const markdownSegment = toMarkdownSegment(before);
    if (markdownSegment) parsedSegments.push(markdownSegment);

    const taggedSegment = parseTaggedSegment({
      type: match[1].toLowerCase() as TaggedSegment["type"],
      body: match[2] || "",
    });
    parsedSegments.push(taggedSegment);
    lastIndex = match.index + match[0].length;
  }

  const trailing = text.slice(lastIndex);
  const trailingSegment = toMarkdownSegment(trailing);
  if (trailingSegment) parsedSegments.push(trailingSegment);

  const hasQuestion = parsedSegments.some((segment) => segment.type === "question");
  const segments = hasQuestion
    ? parsedSegments.filter((segment) => segment.type !== "final_approval")
    : parsedSegments;

  return segments.length ? segments : [{ type: "markdown", text }];
}
