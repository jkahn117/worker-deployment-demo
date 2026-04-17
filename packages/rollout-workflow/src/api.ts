import type {
  DeploymentResponse,
  HealthCheckResult,
  VersionEntry,
} from "./types.js";

const CF_API = "https://api.cloudflare.com/client/v4";

// ---------------------------------------------------------------------------
// Deployments API
// ---------------------------------------------------------------------------

// Returns the version ID currently deployed at 100% (the "stable" version to
// revert to if a health check fails).
export async function getCurrentVersionId(
  apiToken: string,
  accountId: string,
  workerName: string
): Promise<string> {
  const url = `${CF_API}/accounts/${accountId}/workers/scripts/${workerName}/deployments`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch deployments for ${workerName}: ${res.status} ${await res.text()}`
    );
  }

  const data = (await res.json()) as DeploymentResponse;
  const versions = data.result.deployments[0]?.versions;

  if (!versions || versions.length === 0) {
    throw new Error(`No active deployment found for worker: ${workerName}`);
  }

  // The current stable version is the one at 100%, or the highest percentage
  // if no single version holds 100% (e.g. mid-rollout from a previous deploy).
  const stable = versions.reduce((prev, curr) =>
    curr.percentage > prev.percentage ? curr : prev
  );

  return stable.version_id;
}

// Creates a new deployment with the given version percentage split.
// Pass a single entry at 100% for a full cutover or rollback.
export async function createDeployment(
  apiToken: string,
  accountId: string,
  workerName: string,
  versions: VersionEntry[],
  message?: string
): Promise<void> {
  const url = `${CF_API}/accounts/${accountId}/workers/scripts/${workerName}/deployments`;
  const body = {
    strategy: "percentage",
    versions,
    ...(message ? { annotations: { "workers/message": message } } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to create deployment for ${workerName}: ${res.status} ${await res.text()}`
    );
  }
}

// ---------------------------------------------------------------------------
// Analytics API
// ---------------------------------------------------------------------------

// GraphQL query for Workers invocations within a time window.
// Returns aggregate request and error counts for the given script.
const WORKER_ANALYTICS_QUERY = `
  query WorkerErrorRate(
    $accountTag: string!
    $scriptName: string!
    $from: Time!
    $to: Time!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 10000
          filter: {
            scriptName: $scriptName
            datetime_geq: $from
            datetime_leq: $to
          }
        ) {
          sum {
            requests
            errors
          }
        }
      }
    }
  }
`;

// Queries the Cloudflare GraphQL Analytics API for error rate over a window.
// windowMs: length of the soak window in milliseconds (measured back from now)
export async function checkErrorRate(
  apiToken: string,
  accountId: string,
  workerName: string,
  windowMs: number,
  errorThresholdPct: number
): Promise<HealthCheckResult> {
  const now = new Date();
  const from = new Date(now.getTime() - windowMs);

  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: WORKER_ANALYTICS_QUERY,
      variables: {
        accountTag: accountId,
        scriptName: workerName,
        from: from.toISOString(),
        to: now.toISOString(),
      },
    }),
  });

  if (!res.ok) {
    throw new Error(
      `GraphQL analytics request failed: ${res.status} ${await res.text()}`
    );
  }

  const data = (await res.json()) as {
    data?: {
      viewer?: {
        accounts?: Array<{
          workersInvocationsAdaptive?: Array<{
            sum?: { requests: number; errors: number };
          }>;
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (data.errors && data.errors.length > 0) {
    throw new Error(
      `GraphQL error: ${data.errors.map((e) => e.message).join(", ")}`
    );
  }

  const invocations =
    data.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

  // Aggregate across all returned rows.
  let totalRequests = 0;
  let totalErrors = 0;

  for (const row of invocations) {
    totalRequests += row.sum?.requests ?? 0;
    totalErrors += row.sum?.errors ?? 0;
  }

  // No traffic during the soak window — pass the health check rather than
  // rolling back due to missing data.
  if (totalRequests === 0) {
    return { healthy: true, errorRate: 0, requestCount: 0, errorCount: 0 };
  }

  const errorRate = (totalErrors / totalRequests) * 100;
  const healthy = errorRate <= errorThresholdPct;

  return {
    healthy,
    errorRate,
    requestCount: totalRequests,
    errorCount: totalErrors,
  };
}

export async function checkHttpErrorRate(
  healthcheckUrl: string,
  sampleCount: number,
  errorThresholdPct: number
): Promise<HealthCheckResult> {
  const requests = Array.from({ length: sampleCount }, (_, index) => {
    const url = new URL(healthcheckUrl);
    url.searchParams.set("probe", String(index));
    url.searchParams.set("ts", String(Date.now()));

    return fetch(url, {
      headers: {
        "cache-control": "no-store",
      },
    })
      .then((response) => response.ok)
      .catch(() => false);
  });

  const results = await Promise.all(requests);
  const errorCount = results.filter((ok) => !ok).length;
  const requestCount = results.length;
  const errorRate = requestCount === 0 ? 0 : (errorCount / requestCount) * 100;
  const healthy = errorRate <= errorThresholdPct;

  return {
    healthy,
    errorRate,
    requestCount,
    errorCount,
  };
}

// ---------------------------------------------------------------------------
// Soak duration parser
// ---------------------------------------------------------------------------

// Parses a WorkflowSleepDuration into milliseconds for use in GraphQL
// analytics window calculations. Handles both numeric (ms) and string forms.
export function parseDurationMs(duration: WorkflowSleepDuration): number {
  if (typeof duration === "number") return duration;
  const match = duration
    .trim()
    .toLowerCase()
    .match(/^(\d+)\s*(second|seconds|minute|minutes|hour|hours)$/);

  if (!match) {
    throw new Error(
      `Invalid duration format: "${duration}". Expected e.g. "2 minutes", "1 hour".`
    );
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  if (unit.startsWith("second")) return value * 1_000;
  if (unit.startsWith("minute")) return value * 60_000;
  if (unit.startsWith("hour")) return value * 3_600_000;

  throw new Error(`Unrecognised duration unit: "${unit}"`);
}
