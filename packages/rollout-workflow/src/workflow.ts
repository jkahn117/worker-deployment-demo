import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  checkErrorRate,
  createDeployment,
  getCurrentVersionId,
  parseDurationMs,
} from "./api.js";
import type {
  HealthCheckResult,
  RolloutParams,
  RolloutResult,
  WorkerEnv,
} from "./types.js";

// Percentage steps for the gradual rollout.
// Each step soaks for `soakDuration` before the health check fires.
const ROLLOUT_STEPS = [10, 50, 100] as const;

export class RolloutWorkflow extends WorkflowEntrypoint<
  WorkerEnv,
  RolloutParams
> {
  async run(
    event: WorkflowEvent<RolloutParams>,
    step: WorkflowStep
  ): Promise<RolloutResult> {
    const {
      workerName,
      targetVersionId,
      accountId,
      errorThresholdPct,
      soakDuration,
    } = event.payload;

    const apiToken = this.env.CLOUDFLARE_API_TOKEN;
    const soakMs = parseDurationMs(soakDuration);

    // ------------------------------------------------------------------
    // Step 1: Validate — confirm target version exists and capture the
    // current stable version ID for potential rollback.
    // ------------------------------------------------------------------
    const { currentVersionId } = await step.do(
      "validate-version",
      async () => {
        const currentVersionId = await getCurrentVersionId(
          apiToken,
          accountId,
          workerName
        );

        if (currentVersionId === targetVersionId) {
          throw new Error(
            `Target version ${targetVersionId} is already deployed at 100%.`
          );
        }

        return { currentVersionId };
      }
    );

    // ------------------------------------------------------------------
    // Steps 2–N: Gradually increase traffic to targetVersionId.
    // After each step (except 100%) soak and run a health check.
    // On health check failure, roll back and return.
    // ------------------------------------------------------------------
    try {
      for (const pct of ROLLOUT_STEPS) {
        const remaining = 100 - pct;

        // Deploy this percentage split.
        await step.do(`deploy-${pct}-percent`, async () => {
          const versions =
            remaining > 0
              ? [
                  { version_id: targetVersionId, percentage: pct },
                  { version_id: currentVersionId, percentage: remaining },
                ]
              : [{ version_id: targetVersionId, percentage: 100 }];

          await createDeployment(
            apiToken,
            accountId,
            workerName,
            versions,
            `Gradual rollout: ${pct}% → ${targetVersionId}`
          );
        });

        // At 100% we're done — no health check needed after full cutover.
        if (pct === 100) break;

        // Soak at this percentage before checking health.
        await step.sleep(`soak-at-${pct}-percent`, soakDuration);

        // Health check — throws if unhealthy, which is caught below.
        const result: HealthCheckResult = await step.do(
          `check-health-at-${pct}`,
          async () => {
            const health = await checkErrorRate(
              apiToken,
              accountId,
              workerName,
              soakMs,
              errorThresholdPct
            );

            if (!health.healthy) {
              throw new Error(
                `Health check failed at ${pct}%: error rate ${health.errorRate.toFixed(1)}% exceeded threshold ${errorThresholdPct}%` +
                  ` (${health.errorCount} errors / ${health.requestCount} requests)`
              );
            }

            return health;
          }
        );

        console.log(
          `[rollout] ${pct}% health check passed — error rate ${result.errorRate.toFixed(2)}%`
        );
      }
    } catch (err) {
      // ------------------------------------------------------------------
      // Rollback: restore currentVersionId to 100% and surface the reason.
      // ------------------------------------------------------------------
      const reason = err instanceof Error ? err.message : String(err);

      await step.do("rollback", async () => {
        await createDeployment(
          apiToken,
          accountId,
          workerName,
          [{ version_id: currentVersionId, percentage: 100 }],
          `Auto-rollback: ${reason}`
        );
      });

      return {
        success: false,
        rolledBack: true,
        workerName,
        revertedToVersionId: currentVersionId,
        reason,
      };
    }

    return {
      success: true,
      workerName,
      finalVersionId: targetVersionId,
    };
  }
}
