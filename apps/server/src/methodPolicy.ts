import { allowedRpcMethods, type AllowedRpcMethod, type CapabilityDescriptor, type MethodGroup, type RiskTier } from "@assistant/shared";

export type MethodPolicy = {
  method: AllowedRpcMethod;
  group: MethodGroup;
  riskTier: RiskTier;
  requiresExperimentalApi: boolean;
};

const methodPolicyMap: Record<AllowedRpcMethod, MethodPolicy> = {
  "initialize": { method: "initialize", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "initialized": { method: "initialized", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "account/read": { method: "account/read", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "account/login/start": { method: "account/login/start", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "account/login/cancel": { method: "account/login/cancel", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "account/logout": { method: "account/logout", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "thread/start": { method: "thread/start", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "thread/resume": { method: "thread/resume", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "thread/fork": { method: "thread/fork", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "thread/name/set": { method: "thread/name/set", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "thread/list": { method: "thread/list", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "thread/read": { method: "thread/read", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "thread/loaded/list": { method: "thread/loaded/list", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "thread/archive": { method: "thread/archive", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "thread/unarchive": { method: "thread/unarchive", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "thread/unsubscribe": { method: "thread/unsubscribe", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "thread/compact/start": { method: "thread/compact/start", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "thread/rollback": { method: "thread/rollback", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "thread/shellCommand": { method: "thread/shellCommand", group: "ops", riskTier: 3, requiresExperimentalApi: false },
  "turn/start": { method: "turn/start", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "turn/steer": { method: "turn/steer", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "turn/interrupt": { method: "turn/interrupt", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "review/start": { method: "review/start", group: "thread_control", riskTier: 1, requiresExperimentalApi: false },
  "command/exec": { method: "command/exec", group: "ops", riskTier: 2, requiresExperimentalApi: false },
  "command/exec/write": { method: "command/exec/write", group: "ops", riskTier: 2, requiresExperimentalApi: false },
  "command/exec/resize": { method: "command/exec/resize", group: "ops", riskTier: 2, requiresExperimentalApi: false },
  "command/exec/terminate": { method: "command/exec/terminate", group: "ops", riskTier: 2, requiresExperimentalApi: false },
  "model/list": { method: "model/list", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "experimentalFeature/list": { method: "experimentalFeature/list", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "collaborationMode/list": { method: "collaborationMode/list", group: "read", riskTier: 0, requiresExperimentalApi: true },
  "app/list": { method: "app/list", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "skills/list": { method: "skills/list", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "plugin/list": { method: "plugin/list", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "plugin/read": { method: "plugin/read", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "plugin/install": { method: "plugin/install", group: "config_write", riskTier: 2, requiresExperimentalApi: false },
  "plugin/uninstall": { method: "plugin/uninstall", group: "config_write", riskTier: 2, requiresExperimentalApi: false },
  "skills/config/write": { method: "skills/config/write", group: "config_write", riskTier: 2, requiresExperimentalApi: false },
  "mcpServerStatus/list": { method: "mcpServerStatus/list", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "mcpServer/resource/read": { method: "mcpServer/resource/read", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "config/mcpServer/reload": { method: "config/mcpServer/reload", group: "config_write", riskTier: 2, requiresExperimentalApi: false },
  "mcpServer/oauth/login": { method: "mcpServer/oauth/login", group: "config_write", riskTier: 2, requiresExperimentalApi: false },
  "config/read": { method: "config/read", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "config/value/write": { method: "config/value/write", group: "config_write", riskTier: 2, requiresExperimentalApi: false },
  "config/batchWrite": { method: "config/batchWrite", group: "config_write", riskTier: 2, requiresExperimentalApi: false },
  "configRequirements/read": { method: "configRequirements/read", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "externalAgentConfig/detect": { method: "externalAgentConfig/detect", group: "read", riskTier: 0, requiresExperimentalApi: false },
  "externalAgentConfig/import": { method: "externalAgentConfig/import", group: "config_write", riskTier: 2, requiresExperimentalApi: false },
  "feedback/upload": { method: "feedback/upload", group: "config_write", riskTier: 2, requiresExperimentalApi: false },
  "tool/requestUserInput": { method: "tool/requestUserInput", group: "experimental", riskTier: 2, requiresExperimentalApi: true },
  "thread/backgroundTerminals/clean": { method: "thread/backgroundTerminals/clean", group: "experimental", riskTier: 3, requiresExperimentalApi: true },
  "fs/readFile": { method: "fs/readFile", group: "filesystem", riskTier: 2, requiresExperimentalApi: false },
  "fs/writeFile": { method: "fs/writeFile", group: "filesystem", riskTier: 2, requiresExperimentalApi: false },
  "fs/createDirectory": { method: "fs/createDirectory", group: "filesystem", riskTier: 2, requiresExperimentalApi: false },
  "fs/getMetadata": { method: "fs/getMetadata", group: "filesystem", riskTier: 2, requiresExperimentalApi: false },
  "fs/readDirectory": { method: "fs/readDirectory", group: "filesystem", riskTier: 2, requiresExperimentalApi: false },
  "fs/remove": { method: "fs/remove", group: "filesystem", riskTier: 3, requiresExperimentalApi: false },
  "fs/copy": { method: "fs/copy", group: "filesystem", riskTier: 2, requiresExperimentalApi: false },
};

export function getMethodPolicy(method: AllowedRpcMethod): MethodPolicy {
  return methodPolicyMap[method];
}

export function getCapabilityDescriptors(groupEnabled: Record<MethodGroup, boolean>): CapabilityDescriptor[] {
  return allowedRpcMethods.map((method) => {
    const policy = methodPolicyMap[method];
    const enabled = Boolean(groupEnabled[policy.group]);

    return {
      method,
      group: policy.group,
      riskTier: policy.riskTier,
      enabled,
      reason: enabled ? null : `Disabled by group toggle: ${policy.group}`,
      requiresExperimentalApi: policy.requiresExperimentalApi,
    } satisfies CapabilityDescriptor;
  });
}
