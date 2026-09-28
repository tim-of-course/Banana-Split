import { z } from "zod";
import type { JsonObject } from "./model.js";

// App Server wire shapes from the installed CLI's app-server generate-json-schema.
const decision = z.enum(["accept", "acceptForSession", "decline", "cancel"]);
const specialPath = z.union([
  z.object({ kind: z.enum(["root", "minimal", "tmpdir", "slash_tmp"]) }),
  z.object({ kind: z.literal("project_roots"), subpath: z.string().nullish() }),
  z.object({ kind: z.literal("unknown"), path: z.string(), subpath: z.string().nullish() })
]);
const filePath = z.union([
  z.object({ type: z.literal("path"), path: z.string() }),
  z.object({ type: z.literal("glob_pattern"), pattern: z.string() }),
  z.object({ type: z.literal("special"), value: specialPath })
]);
const schemas: Record<string, z.ZodType> = {
  "item/commandExecution/requestApproval": z.object({ decision: z.union([
    decision,
    z.object({ acceptWithExecpolicyAmendment: z.object({ execpolicy_amendment: z.array(z.string()) }) }),
    z.object({ applyNetworkPolicyAmendment: z.object({ network_policy_amendment: z.object({ host: z.string(), action: z.enum(["allow", "deny"]) }) }) })
  ]) }),
  "item/fileChange/requestApproval": z.object({ decision }),
  "item/permissions/requestApproval": z.object({
    permissions: z.object({
      network: z.object({ enabled: z.boolean().nullish() }).nullish(),
      fileSystem: z.object({
        read: z.array(z.string()).nullish(), write: z.array(z.string()).nullish(),
        globScanMaxDepth: z.number().int().positive().nullish(),
        entries: z.array(z.object({ path: filePath, access: z.enum(["read", "write", "deny"]) })).nullish()
      }).nullish()
    }),
    scope: z.enum(["turn", "session"]).optional(), strictAutoReview: z.boolean().nullish()
  }),
  "item/tool/requestUserInput": z.object({ answers: z.record(z.string(), z.object({ answers: z.array(z.string()) })) }),
  "mcpServer/elicitation/request": z.object({ action: z.enum(["accept", "decline", "cancel"]), content: z.json().nullish(), _meta: z.json().nullish() })
};

export function validateApprovalResponse(method: string, response: JsonObject): void {
  const schema = schemas[method];
  if (!schema) throw new Error(`Unsupported App Server approval method: ${method}`);
  const parsed = schema.safeParse(response);
  if (!parsed.success) throw new Error(`Invalid ${method} response: ${parsed.error.message}`);
  // Validate without stripping compatible protocol fields from the relayed response.
}
