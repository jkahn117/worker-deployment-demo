import { Hono } from "hono";
import { z } from "zod";
import { RolloutWorkflow } from "./workflow.js";
import type { WorkerEnv } from "./types.js";

// Re-export the Workflow class so wrangler can find it as a named export.
export { RolloutWorkflow };

const app = new Hono<{ Bindings: WorkerEnv }>();

// ---------------------------------------------------------------------------
// Input validation schema
// ---------------------------------------------------------------------------

const TriggerSchema = z.object({
  workerName: z.string().min(1),
  targetVersionId: z.string().min(1),
  accountId: z.string().min(1),
  // Default to 2% error threshold — callers may override for tighter/looser gates.
  errorThresholdPct: z.number().min(0).max(100).default(2.0),
  // Default to 2 minutes for demo; production use should increase this.
  soakDuration: z.string().default("2 minutes"),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /trigger — create a new Rollout Workflow instance
app.post("/trigger", async (c) => {
  const body = await c.req.json().catch(() => null);

  if (body === null) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = TriggerSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid request", issues: parsed.error.issues },
      400
    );
  }

  // Cast soakDuration to WorkflowSleepDuration — Zod validates the string is
  // well-formed, and the template-literal type is compatible at runtime.
  const params = {
    ...parsed.data,
    soakDuration: parsed.data.soakDuration as WorkflowSleepDuration,
  };

  const instance = await c.env.ROLLOUT_WORKFLOW.create({ params });

  // Construct the dashboard deep-link so the presenter can paste it directly
  // into a browser to watch step progression in real time.
  const dashboardUrl =
    `https://dash.cloudflare.com/${params.accountId}/workers/services/view/` +
    `rollout-workflow/production/workflows/rollout-workflow/instances/${instance.id}`;

  return c.json(
    {
      instanceId: instance.id,
      dashboardUrl,
    },
    201
  );
});

// GET /status/:instanceId — poll workflow instance status
app.get("/status/:instanceId", async (c) => {
  const instanceId = c.req.param("instanceId");

  let instance: WorkflowInstance;
  try {
    instance = await c.env.ROLLOUT_WORKFLOW.get(instanceId);
  } catch {
    return c.json({ error: "Instance not found", instanceId }, 404);
  }

  const status = await instance.status();

  return c.json({ instanceId, ...status });
});

export default app;
