(function exposeCostPolicy(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ZuochengCostPolicy = api;
  }
})(typeof globalThis === "object" ? globalThis : this, function createCostPolicyModule() {
  "use strict";

  const CORE_CAPABILITIES = Object.freeze([
    "task_planning",
    "progress_storage",
    "markdown_export",
    "task_reset",
  ]);
  const DEFAULT_COST_CONFIG = Object.freeze({
    COST_MODE: "zero_owner_cost",
    ALLOW_AUTOMATIC_BILLING: false,
    REMOTE_PROVIDERS: Object.freeze([]),
    CORE_CAPABILITIES,
  });
  const FREE_REMOTE_BILLING = new Set(["free", "free_quota"]);

  function decision(allowed, code, usage = "not_applicable") {
    return { allowed, code, ownerCost: 0, usage };
  }

  function createCostPolicy(overrides = {}) {
    const config = Object.freeze({ ...DEFAULT_COST_CONFIG, ...overrides });

    function authorize(request = {}) {
      if (request.execution === "local") {
        return decision(true, "local_zero_cost");
      }
      if (request.execution !== "remote") {
        return decision(false, "execution_unverified");
      }

      const billing = String(request.billing ?? "unknown");
      if (
        config.COST_MODE === "zero_owner_cost" &&
        (!FREE_REMOTE_BILLING.has(billing) || request.mayChargeOwner === true)
      ) {
        return decision(false, "paid_provider_blocked");
      }

      if (!Number.isFinite(request.remainingQuota)) {
        return decision(false, "quota_unverified", "unverified");
      }
      if (request.remainingQuota <= 0) {
        return decision(false, "quota_exhausted", "exhausted");
      }

      return decision(true, "remote_free_quota", request.remainingQuota);
    }

    return Object.freeze({
      mode: config.COST_MODE,
      automaticBilling: config.ALLOW_AUTOMATIC_BILLING,
      coreCapabilities: config.CORE_CAPABILITIES,
      authorize,
    });
  }

  return Object.freeze({ DEFAULT_COST_CONFIG, createCostPolicy });
});
