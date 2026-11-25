import { stageUsage, type Ctx, type StageUsage } from "./ctx.ts";
import { runStage, type RunStageInfo, type StageClaim, type StageJob } from "./stages.ts";
import { plainResult, type Scheduler } from "./scheduler.ts";

export function makeStageLoop(
  ctx: Ctx,
  handler: (ctx: Ctx, job: StageJob, claim: StageClaim) => Promise<"done" | "skipped" | "handoff">,
  afterStage: Scheduler["afterStage"],
) {
  return async (jobs: readonly { data: StageJob }[]) => {
    for (const j of jobs) {
      const used: StageUsage = { tokens: 0, calls: 0 };
      const info: RunStageInfo = {};                              // retry (StageWait): reason and wait term — for afterStage
      const status = await stageUsage.run(used, () => runStage(ctx, j.data, (claim) => handler(ctx, j.data, claim), info));
      if (status === null) continue;                              // stage not claimed (duplicate job or already done) — no audit or scheduling
      await afterStage(j.data, plainResult(status, info.wait?.code, info.wait?.retryAt, info.wait?.repeat), used);
    }
  };
}
