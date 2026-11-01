import { PIService } from "../apps/server/src/pi-clarification/service.js";
async function main() {
  const service = new PIService({
    root: process.cwd(),
    file: ":memory:",
    demo: true,
  });
  try {
    const detail = await service.replay(
      process.argv.includes("--ppo") ? "ppo" : "ar",
    );
    console.log(
      JSON.stringify(
        {
          synthetic: true,
          realEmailsSent: 0,
          case: detail.case,
          approval: detail.approvals.at(-1) || null,
          implementationTask: detail.handoffs.at(-1) || null,
          eventKinds: detail.events.map((e) => e.kind),
        },
        null,
        2,
      ),
    );
    const expected = process.argv.includes("--ppo")
      ? "ESCALATED"
      : "HANDED_OFF";
    if (detail.case.state !== expected)
      throw new Error(`Expected ${expected}; received ${detail.case.state}`);
  } finally {
    await service.stop();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Demo failed");
  process.exitCode = 1;
});
